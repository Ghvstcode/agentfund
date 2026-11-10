package codexauth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

var t0 = time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)

func jwt(claims map[string]any) string {
	h := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`))
	p, _ := json.Marshal(claims)
	return h + "." + base64.RawURLEncoding.EncodeToString(p) + ".sig"
}

func access(exp time.Time, n int) string {
	return jwt(map[string]any{"exp": exp.Unix(), "n": n})
}

var idToken = jwt(map[string]any{"email": "backer@example.com", "https://api.openai.com/auth": map[string]any{"chatgpt_account_id": "acct-1", "chatgpt_plan_type": "plus"}})

func writeLogin(t *testing.T, home string, accessToken, refresh string, extra map[string]any) {
	t.Helper()
	doc := map[string]any{
		"auth_mode":      "chatgpt",
		"OPENAI_API_KEY": nil,
		"tokens": map[string]any{
			"id_token":         idToken,
			"access_token":     accessToken,
			"refresh_token":    refresh,
			"account_id":       "acct-1",
			"login_owner_id":   "owner-1",
			"oauth_provenance": nil,
		},
		"last_refresh": t0.Add(-time.Hour).Format(time.RFC3339),
	}
	for k, v := range extra {
		doc[k] = v
	}
	data, _ := json.Marshal(doc)
	if err := os.WriteFile(AuthPath(home), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

// tokenServer rotates refresh tokens the way auth.openai.com does: each one
// works once, and reusing it fails with refresh_token_reused.
type tokenServer struct {
	mu    sync.Mutex
	valid map[string]bool
	calls atomic.Int32
	n     int
}

func newTokenServer(t *testing.T, refresh string) (*tokenServer, *httptest.Server) {
	ts := &tokenServer{valid: map[string]bool{refresh: true}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ts.calls.Add(1)
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["grant_type"] != "refresh_token" || body["client_id"] != ClientID {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		ts.mu.Lock()
		defer ts.mu.Unlock()
		if !ts.valid[body["refresh_token"]] {
			w.WriteHeader(http.StatusUnauthorized)
			fmt.Fprint(w, `{"error":{"message":"Your refresh token has already been used","type":"invalid_request_error","code":"refresh_token_reused"}}`)
			return
		}
		delete(ts.valid, body["refresh_token"])
		ts.n++
		next := fmt.Sprintf("rt-%d", ts.n)
		ts.valid[next] = true
		_ = json.NewEncoder(w).Encode(map[string]string{
			"id_token": idToken, "access_token": access(t0.Add(10*24*time.Hour), ts.n), "refresh_token": next,
		})
	}))
	t.Cleanup(srv.Close)
	return ts, srv
}

func refresher(home, url string) *Refresher {
	return &Refresher{Home: home, TokenURL: url, Now: func() time.Time { return t0 }}
}

func TestFreshKeepsAValidToken(t *testing.T) {
	home := t.TempDir()
	writeLogin(t, home, access(t0.Add(48*time.Hour), 0), "rt-0", nil)
	ts, srv := newTokenServer(t, "rt-0")
	tok, err := refresher(home, srv.URL).Fresh(context.Background(), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if ts.calls.Load() != 0 {
		t.Fatalf("refreshed a token that was valid for the whole run")
	}
	if tok.AccountID != "acct-1" || tok.RefreshToken != "rt-0" || !tok.Expires.Equal(t0.Add(48*time.Hour)) {
		t.Fatalf("tokens = %+v", tok)
	}
}

func TestFreshRefreshesAndKeepsUnknownFields(t *testing.T) {
	home := t.TempDir()
	writeLogin(t, home, access(t0.Add(30*time.Minute), 0), "rt-0", map[string]any{"agent_identity": map[string]any{"future": true}})
	_, srv := newTokenServer(t, "rt-0")
	tok, err := refresher(home, srv.URL).Fresh(context.Background(), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if tok.RefreshToken != "rt-1" || !tok.Expires.Equal(t0.Add(10*24*time.Hour)) {
		t.Fatalf("tokens = %+v", tok)
	}
	st, err := os.Stat(AuthPath(home))
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("auth.json mode = %v", st.Mode().Perm())
	}
	var doc map[string]any
	data, _ := os.ReadFile(AuthPath(home))
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	if doc["agent_identity"] == nil {
		t.Fatalf("lost a top-level field: %s", data)
	}
	tokens := doc["tokens"].(map[string]any)
	if tokens["login_owner_id"] != "owner-1" || tokens["refresh_token"] != "rt-1" {
		t.Fatalf("tokens after refresh: %v", tokens)
	}
	if doc["last_refresh"] != t0.Format(time.RFC3339Nano) {
		t.Fatalf("last_refresh = %v", doc["last_refresh"])
	}
	if left, _ := filepath.Glob(filepath.Join(home, ".auth-*")); len(left) != 0 {
		t.Fatalf("temporary files left behind: %v", left)
	}
}

func TestFreshReusedRefreshTokenIsALoginProblem(t *testing.T) {
	home := t.TempDir()
	writeLogin(t, home, access(t0.Add(-time.Minute), 0), "rt-stale", nil)
	_, srv := newTokenServer(t, "rt-0")
	_, err := refresher(home, srv.URL).Fresh(context.Background(), time.Hour)
	if !errors.Is(err, ErrLogin) || !strings.Contains(err.Error(), "refresh_token_reused") {
		t.Fatalf("err = %v", err)
	}
}

func TestFreshServerErrorIsNotALoginProblem(t *testing.T) {
	home := t.TempDir()
	writeLogin(t, home, access(t0.Add(-time.Minute), 0), "rt-0", nil)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv.Close()
	_, err := refresher(home, srv.URL).Fresh(context.Background(), time.Hour)
	if err == nil || errors.Is(err, ErrLogin) {
		t.Fatalf("err = %v", err)
	}
}

// Two workers sharing the login must not both spend the same refresh token:
// the second one waits for the lock, re-reads, and finds a fresh token.
func TestFreshConcurrentRefreshesSpendOneRefreshToken(t *testing.T) {
	home := t.TempDir()
	writeLogin(t, home, access(t0.Add(time.Minute), 0), "rt-0", nil)
	ts, srv := newTokenServer(t, "rt-0")
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for range 8 {
		wg.Go(func() {
			_, err := refresher(home, srv.URL).Fresh(context.Background(), time.Hour)
			errs <- err
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if n := ts.calls.Load(); n != 1 {
		t.Fatalf("token endpoint called %d times, want 1", n)
	}
}

func TestFreshNoLogin(t *testing.T) {
	for name, setup := range map[string]func(home string){
		"missing directory": func(string) {},
		"missing file":      func(home string) { _ = os.MkdirAll(home, 0o700) },
		"api key login": func(home string) {
			_ = os.MkdirAll(home, 0o700)
			_ = os.WriteFile(AuthPath(home), []byte(`{"auth_mode":"apikey","OPENAI_API_KEY":"sk-x"}`), 0o600)
		},
	} {
		t.Run(name, func(t *testing.T) {
			home := filepath.Join(t.TempDir(), "codex")
			setup(home)
			if Exists(home) {
				t.Fatal("Exists = true")
			}
			if _, err := refresher(home, "http://127.0.0.1:1").Fresh(context.Background(), time.Hour); !errors.Is(err, ErrNoLogin) {
				t.Fatalf("err = %v", err)
			}
		})
	}
}

func TestSandboxAuthJSONHasNoRefreshToken(t *testing.T) {
	tok := Tokens{IDToken: idToken, AccessToken: "at", RefreshToken: "rt-secret", AccountID: "acct-1"}
	data, err := SandboxAuthJSON(tok, t0)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "rt-secret") {
		t.Fatalf("refresh token in the sandbox copy: %s", data)
	}
	var doc struct {
		AuthMode string `json:"auth_mode"`
		Tokens   struct {
			IDToken      string `json:"id_token"`
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
			AccountID    string `json:"account_id"`
		} `json:"tokens"`
		LastRefresh string `json:"last_refresh"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	if doc.AuthMode != "chatgpt" || doc.Tokens.AccessToken != "at" || doc.Tokens.IDToken != idToken ||
		doc.Tokens.RefreshToken != "" || doc.Tokens.AccountID != "acct-1" || doc.LastRefresh != t0.Format(time.RFC3339Nano) {
		t.Fatalf("sandbox auth.json = %s", data)
	}
}
