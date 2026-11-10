// Package codexauth keeps a backer's dedicated Codex ChatGPT sign-in fresh on
// the host and produces the stripped copy that goes into the sandbox.
//
// The design is docs/dev/codex-chatgpt-signin.md, option (c2). In short: the
// backer runs `CODEX_HOME=<home> codex login` once, in a directory used only
// by AgentFund. Before each run the worker refreshes that login on the host if
// its access token would expire during the run, the same way Codex 0.167.0
// does (flock on <home>/auth.lock, re-read, POST to auth.openai.com, atomic
// replace that keeps every field it does not know). The sandbox only ever
// gets the access and id tokens, never the refresh token.
package codexauth

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// Defaults copied from the Codex source (codex-rs/login/src/auth/manager.rs,
// rust-v0.167.0). OpenAI does not document this endpoint; if it changes,
// refresh fails closed with ErrLogin or a transport error.
const (
	TokenURL = "https://auth.openai.com/oauth/token"
	ClientID = "app_EMoamEEZ73f0CkXaXp7hrann"
)

// ErrNoLogin means there is no ChatGPT sign-in in the directory.
var ErrNoLogin = errors.New("no Codex ChatGPT sign-in")

// ErrTooShort means even a freshly refreshed access token expires before the
// run could end: tasks this long cannot run on this sign-in, and refreshing
// again would only rotate the refresh token for nothing.
var ErrTooShort = errors.New("the Codex access token does not last long enough")

// ErrLogin means the sign-in can no longer be refreshed (the refresh token
// was used elsewhere, expired or was revoked): `codex login` must be run again.
var ErrLogin = errors.New("the Codex ChatGPT sign-in has to be renewed")

// Tokens are the parts of a ChatGPT sign-in that a run needs.
type Tokens struct {
	IDToken      string
	AccessToken  string
	RefreshToken string // host only; never handed to the sandbox
	AccountID    string
	// Expires is the access token's exp claim (zero if it has none).
	Expires time.Time
}

// Refresher refreshes the sign-in stored in Home.
type Refresher struct {
	Home     string
	TokenURL string // "" = TokenURL
	ClientID string // "" = ClientID
	HTTP     *http.Client
	Now      func() time.Time
}

// AuthPath is the auth.json inside home.
func AuthPath(home string) string { return filepath.Join(home, "auth.json") }

// Exists reports whether home holds a ChatGPT sign-in (it does not check
// whether it is still valid).
func Exists(home string) bool {
	doc, err := readDoc(AuthPath(home))
	if err != nil {
		return false
	}
	_, err = doc.tokens()
	return err == nil
}

// Fresh returns tokens whose access token is valid for at least validFor,
// refreshing (and rewriting auth.json) first if it is not.
func (r *Refresher) Fresh(ctx context.Context, validFor time.Duration) (Tokens, error) {
	unlock, err := lock(r.Home)
	if err != nil {
		return Tokens{}, err
	}
	defer unlock()
	// Re-read under the lock: another process (a second worker, or Codex run
	// with the same CODEX_HOME) may have refreshed meanwhile.
	doc, err := readDoc(AuthPath(r.Home))
	if err != nil {
		return Tokens{}, err
	}
	tok, err := doc.tokens()
	if err != nil {
		return Tokens{}, err
	}
	if !tok.Expires.IsZero() && tok.Expires.After(r.now().Add(validFor)) {
		return tok, nil
	}
	if tok.RefreshToken == "" {
		return Tokens{}, fmt.Errorf("%w: it has no refresh token", ErrLogin)
	}
	tokenURL, clientID := r.endpoint(doc)
	resp, err := r.post(ctx, tokenURL, clientID, tok.RefreshToken)
	if err != nil {
		return Tokens{}, err
	}
	if err := doc.update(resp, r.now()); err != nil {
		return Tokens{}, err
	}
	if err := writeDoc(AuthPath(r.Home), doc); err != nil {
		// The server has already rotated the refresh token; losing the new
		// one means the sign-in is gone. Say so plainly.
		return Tokens{}, fmt.Errorf("refreshed the Codex sign-in but could not save it (run `codex login` again): %w", err)
	}
	tok, err = doc.tokens()
	if err != nil {
		return Tokens{}, err
	}
	if !tok.Expires.IsZero() && !tok.Expires.After(r.now().Add(validFor)) {
		return Tokens{}, fmt.Errorf("%w: a fresh one is valid for %s, the run needs %s", ErrTooShort, tok.Expires.Sub(r.now()).Round(time.Minute), validFor)
	}
	return tok, nil
}

// SandboxAuthJSON is the auth.json for the sandbox: a ChatGPT sign-in with no
// refresh token, and last_refresh set to now so that Codex sees no reason to
// refresh (it would have nothing to refresh with, and auth.openai.com is not
// reachable from the sandbox).
func SandboxAuthJSON(t Tokens, now time.Time) ([]byte, error) {
	return json.Marshal(map[string]any{
		"auth_mode":      "chatgpt",
		"OPENAI_API_KEY": nil,
		"tokens": map[string]any{
			"id_token":      t.IDToken,
			"access_token":  t.AccessToken,
			"refresh_token": "",
			"account_id":    t.AccountID,
		},
		"last_refresh": now.UTC().Format(time.RFC3339Nano),
	})
}

func (r *Refresher) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

// endpoint follows Codex: a login that recorded its issuer and client refreshes
// there, otherwise the defaults.
func (r *Refresher) endpoint(d doc) (string, string) {
	tokenURL, clientID := firstNonEmpty(r.TokenURL, TokenURL), firstNonEmpty(r.ClientID, ClientID)
	var p struct {
		Issuer   string `json:"issuer"`
		ClientID string `json:"client_id"`
	}
	if raw, ok := d.tok["oauth_provenance"]; ok && json.Unmarshal(raw, &p) == nil && p.Issuer != "" && p.ClientID != "" && r.TokenURL == "" {
		return strings.TrimRight(p.Issuer, "/") + "/oauth/token", p.ClientID
	}
	return tokenURL, clientID
}

type refreshResponse struct {
	IDToken      string `json:"id_token"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
}

func (r *Refresher) post(ctx context.Context, tokenURL, clientID, refreshToken string) (refreshResponse, error) {
	body, _ := json.Marshal(map[string]string{
		"client_id":     clientID,
		"grant_type":    "refresh_token",
		"refresh_token": refreshToken,
	})
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, bytes.NewReader(body))
	if err != nil {
		return refreshResponse{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	client := r.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	res, err := client.Do(req)
	if err != nil {
		return refreshResponse{}, fmt.Errorf("refresh the Codex sign-in: %w", err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode != http.StatusOK {
		var e struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(data, &e)
		switch strings.ToLower(e.Error.Code) {
		case "refresh_token_reused", "refresh_token_expired", "refresh_token_invalidated":
			return refreshResponse{}, fmt.Errorf("%w (%s)", ErrLogin, strings.ToLower(e.Error.Code))
		}
		if res.StatusCode == http.StatusBadRequest || res.StatusCode == http.StatusUnauthorized {
			return refreshResponse{}, fmt.Errorf("%w (HTTP %d)", ErrLogin, res.StatusCode)
		}
		return refreshResponse{}, fmt.Errorf("refresh the Codex sign-in: HTTP %d", res.StatusCode)
	}
	var out refreshResponse
	if err := json.Unmarshal(data, &out); err != nil || out.AccessToken == "" {
		return refreshResponse{}, errors.New("refresh the Codex sign-in: the response has no access token")
	}
	return out, nil
}

// doc is auth.json kept as raw JSON so that fields this package does not know
// (agent_identity, oauth_provenance, login_owner_id, ...) survive a rewrite.
type doc struct {
	top map[string]json.RawMessage
	tok map[string]json.RawMessage
}

func readDoc(path string) (doc, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return doc{}, ErrNoLogin
	}
	if err != nil {
		return doc{}, err
	}
	d := doc{}
	if err := json.Unmarshal(data, &d.top); err != nil {
		return doc{}, fmt.Errorf("%s is not valid JSON: %w", path, err)
	}
	if raw, ok := d.top["tokens"]; ok && string(raw) != "null" {
		if err := json.Unmarshal(raw, &d.tok); err != nil {
			return doc{}, fmt.Errorf("%s: tokens: %w", path, err)
		}
	}
	return d, nil
}

func (d doc) str(m map[string]json.RawMessage, key string) string {
	var s string
	if raw, ok := m[key]; ok {
		_ = json.Unmarshal(raw, &s)
	}
	return s
}

func (d doc) tokens() (Tokens, error) {
	if mode := d.str(d.top, "auth_mode"); mode != "" && mode != "chatgpt" {
		return Tokens{}, fmt.Errorf("%w (auth_mode is %q)", ErrNoLogin, mode)
	}
	t := Tokens{
		IDToken:      d.str(d.tok, "id_token"),
		AccessToken:  d.str(d.tok, "access_token"),
		RefreshToken: d.str(d.tok, "refresh_token"),
		AccountID:    d.str(d.tok, "account_id"),
	}
	if t.AccessToken == "" || t.IDToken == "" {
		return Tokens{}, ErrNoLogin
	}
	if t.AccountID == "" {
		t.AccountID = accountIDClaim(t.IDToken)
	}
	t.Expires = expClaim(t.AccessToken)
	return t, nil
}

func (d *doc) update(r refreshResponse, now time.Time) error {
	set := func(m map[string]json.RawMessage, k, v string) {
		raw, _ := json.Marshal(v)
		m[k] = raw
	}
	if r.IDToken != "" {
		set(d.tok, "id_token", r.IDToken)
	}
	set(d.tok, "access_token", r.AccessToken)
	if r.RefreshToken != "" {
		set(d.tok, "refresh_token", r.RefreshToken)
	}
	raw, err := json.Marshal(d.tok)
	if err != nil {
		return err
	}
	d.top["tokens"] = raw
	set(d.top, "last_refresh", now.UTC().Format(time.RFC3339Nano))
	return nil
}

// writeDoc replaces path atomically with mode 0600, like Codex does.
func writeDoc(path string, d doc) error {
	data, err := json.MarshalIndent(d.top, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".auth-")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(append(data, '\n')); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// lock takes the same advisory lock Codex takes before it refreshes.
func lock(home string) (func(), error) {
	f, err := os.OpenFile(filepath.Join(home, "auth.lock"), os.O_RDWR|os.O_CREATE, 0o600)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNoLogin
	}
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		f.Close()
		return nil, err
	}
	return func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		f.Close()
	}, nil
}

// jwtClaims decodes a JWT payload without verifying it: the values are only
// used to decide when to refresh, never to grant anything.
func jwtClaims(jwt string, v any) bool {
	parts := strings.Split(jwt, ".")
	if len(parts) != 3 {
		return false
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return false
	}
	return json.Unmarshal(payload, v) == nil
}

func expClaim(jwt string) time.Time {
	var c struct {
		Exp int64 `json:"exp"`
	}
	if !jwtClaims(jwt, &c) || c.Exp == 0 {
		return time.Time{}
	}
	return time.Unix(c.Exp, 0)
}

func accountIDClaim(jwt string) string {
	var c struct {
		Auth struct {
			AccountID string `json:"chatgpt_account_id"`
		} `json:"https://api.openai.com/auth"`
	}
	jwtClaims(jwt, &c)
	return c.Auth.AccountID
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
