package runner

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func fakeJWT(claims map[string]any) string {
	p, _ := json.Marshal(claims)
	return "eyJhbGciOiJub25lIn0." + base64.RawURLEncoding.EncodeToString(p) + ".sig"
}

func TestCodexCredentialsPersonalAccessToken(t *testing.T) {
	c := NewCodex()
	ctx := context.Background()
	got, err := c.Credentials(ctx, env(map[string]string{EnvCodexAccessToken: "at-aaaaaaaaaaaa", "EXTRA": "extra-value"}), "", []string{"EXTRA"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(got.PassEnv, ",") != EnvCodexAccessToken+",EXTRA" || !slices.Contains(got.Secrets, "at-aaaaaaaaaaaa") {
		t.Fatalf("pat: %+v", got)
	}
	if strings.Join(got.Hosts, ",") != CodexChatGPTHost+","+CodexAuthHost || got.Renew != nil || len(got.HomeFiles) != 0 {
		t.Fatalf("pat hosts/renew/files: %+v", got)
	}
	// An API key wins over a PAT (Codex itself reads CODEX_API_KEY first).
	got, err = c.Credentials(ctx, env(map[string]string{EnvCodexAPIKey: "sk-proj-aaaaaaaa", EnvCodexAccessToken: "at-aaaaaaaaaaaa"}), "", nil)
	if err != nil || strings.Join(got.PassEnv, ",") != EnvCodexAPIKey || got.Hosts != nil {
		t.Fatalf("api key and pat: %+v %v", got, err)
	}
	// A token command that prints a PAT is forwarded as CODEX_ACCESS_TOKEN.
	got, err = c.Credentials(ctx, env(nil), "printf 'at-fromcommand\\n'", nil)
	if err != nil || len(got.Env) != 1 || got.Env[0] != EnvCodexAccessToken+"=at-fromcommand" || len(got.Hosts) != 2 {
		t.Fatalf("pat token command: %+v %v", got, err)
	}
}

// signInHome writes a dedicated sign-in like `codex login` does.
func signInHome(t *testing.T, accessExp time.Time) string {
	t.Helper()
	home := filepath.Join(t.TempDir(), "codex")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	doc := map[string]any{
		"auth_mode": "chatgpt", "OPENAI_API_KEY": nil,
		"tokens": map[string]any{
			"id_token":      fakeJWT(map[string]any{"email": "backer@example.com"}),
			"access_token":  fakeJWT(map[string]any{"exp": accessExp.Unix(), "v": "old"}),
			"refresh_token": "rt-host-only-0",
			"account_id":    "acct-1",
		},
		"last_refresh": accessExp.Add(-24 * time.Hour).Format(time.RFC3339),
	}
	data, _ := json.Marshal(doc)
	if err := os.WriteFile(filepath.Join(home, "auth.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	return home
}

func TestCodexCredentialsChatGPTSignIn(t *testing.T) {
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	home := signInHome(t, now.Add(2*time.Hour))
	refreshed := fakeJWT(map[string]any{"exp": now.Add(10 * 24 * time.Hour).Unix(), "v": "new"})
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		fmt.Fprintf(w, `{"access_token":%q,"refresh_token":"rt-host-only-1"}`, refreshed)
	}))
	defer srv.Close()
	c := &Codex{Binary: "codex", Home: home, TokenURL: srv.URL, Now: func() time.Time { return now }}

	got, err := c.Credentials(context.Background(), env(nil), "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if calls != 0 {
		t.Fatalf("refreshed at start-up although the token is valid for 2h")
	}
	if strings.Join(got.Hosts, ",") != CodexChatGPTHost || got.Renew == nil || len(got.PassEnv) != 0 || len(got.Env) != 0 {
		t.Fatalf("sign-in credentials: %+v", got)
	}
	if len(got.HomeFiles) != 1 || got.HomeFiles[0].Path != ".codex/auth.json" {
		t.Fatalf("home files: %+v", got.HomeFiles)
	}
	if strings.Contains(string(got.HomeFiles[0].Data), "rt-host-only") {
		t.Fatalf("refresh token in the sandbox file: %s", got.HomeFiles[0].Data)
	}
	if !slices.Contains(got.Secrets, "rt-host-only-0") {
		t.Fatalf("refresh token is not scrubbed: %v", got.Secrets)
	}

	// A run that may last 3h needs a refresh first.
	run, err := got.Renew(context.Background(), 3*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if calls != 1 || !strings.Contains(string(run.HomeFiles[0].Data), refreshed) || !slices.Contains(run.Secrets, refreshed) {
		t.Fatalf("renewed: calls=%d %+v", calls, run)
	}
	if strings.Contains(string(run.HomeFiles[0].Data), "rt-host-only") {
		t.Fatalf("refresh token in the sandbox file: %s", run.HomeFiles[0].Data)
	}
	host, _ := os.ReadFile(filepath.Join(home, "auth.json"))
	if !strings.Contains(string(host), "rt-host-only-1") {
		t.Fatalf("host sign-in not updated: %s", host)
	}
}

func TestCodexCredentialsSignInNeedsRenewal(t *testing.T) {
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	home := signInHome(t, now.Add(-time.Hour))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"error":{"code":"refresh_token_reused","message":"used"}}`)
	}))
	defer srv.Close()
	c := &Codex{Binary: "codex", Home: home, TokenURL: srv.URL, Now: func() time.Time { return now }}
	_, err := c.Credentials(context.Background(), env(nil), "", nil)
	if !errors.Is(err, ErrCredentials) || !strings.Contains(err.Error(), CodexLoginCommand(home)) {
		t.Fatalf("err = %v", err)
	}
}

func TestCodexCredentialsNoSignInMentionsLogin(t *testing.T) {
	c := &Codex{Binary: "codex", Home: filepath.Join(t.TempDir(), "codex")}
	_, err := c.Credentials(context.Background(), env(nil), "", nil)
	if err == nil || !strings.Contains(err.Error(), CodexLoginCommand(c.Home)) || !strings.Contains(err.Error(), EnvCodexAccessToken) {
		t.Fatalf("err = %v", err)
	}
}

// The stripped sign-in is written into the sandbox home through stdin before
// codex starts, and never appears on a command line.
func TestCodexRunWritesHomeFilesFirst(t *testing.T) {
	var order []string
	var written string
	exec := func(ctx context.Context, cmd, pass, env []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
		switch {
		case len(cmd) == 2 && cmd[1] == "--version":
			return 0, nil
		case cmd[0] == "sh":
			order = append(order, "write "+cmd[len(cmd)-1])
			b, _ := io.ReadAll(stdin)
			written = string(b)
			return 0, nil
		}
		order = append(order, "codex")
		fmt.Fprintln(stdout, `{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}`)
		return 0, nil
	}
	_, err := NewCodex().Run(context.Background(), RunSpec{
		Prompt: "p", Exec: exec,
		Creds: Credentials{HomeFiles: []HomeFile{{Path: ".codex/auth.json", Data: []byte(`{"secret":"at"}`)}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(order, ",") != "write .codex/auth.json,codex" || written != `{"secret":"at"}` {
		t.Fatalf("order %v written %q", order, written)
	}

	failing := func(ctx context.Context, cmd, pass, env []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
		if cmd[0] == "sh" {
			fmt.Fprint(stderr, "read-only file system")
			return 1, nil
		}
		if len(cmd) == 2 && cmd[1] == "--version" {
			return 0, nil
		}
		t.Fatalf("codex started although its sign-in could not be written: %v", cmd)
		return 0, nil
	}
	if _, err := NewCodex().Run(context.Background(), RunSpec{Prompt: "p", Exec: failing,
		Creds: Credentials{HomeFiles: []HomeFile{{Path: ".codex/auth.json", Data: []byte("x")}}}}); err == nil || !strings.Contains(err.Error(), "read-only") {
		t.Fatalf("err = %v", err)
	}
}

// A token that cannot outlast the run even when fresh stops the worker:
// releasing and re-claiming would rotate the refresh token every time.
func TestCodexCredentialsTokenTooShortForTheRun(t *testing.T) {
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	home := signInHome(t, now.Add(2*time.Hour))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `{"access_token":%q,"refresh_token":"rt-host-only-1"}`, fakeJWT(map[string]any{"exp": now.Add(time.Hour).Unix()}))
	}))
	defer srv.Close()
	c := &Codex{Binary: "codex", Home: home, TokenURL: srv.URL, Now: func() time.Time { return now }}
	creds, err := c.Credentials(context.Background(), env(nil), "", nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = creds.Renew(context.Background(), 3*time.Hour)
	if !errors.Is(err, ErrCredentials) || !strings.Contains(err.Error(), "valid for 1h0m0s") {
		t.Fatalf("err = %v", err)
	}
}

// The sign-in is made with the Codex version that runs in the sandbox.
func TestCodexCLIVersionMatchesTheSandboxImage(t *testing.T) {
	df, err := os.ReadFile("../../../images/sandbox/Dockerfile")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(df), "ARG CODEX_VERSION="+CodexCLIVersion+"\n") {
		t.Fatalf("CodexCLIVersion %s is not CODEX_VERSION in images/sandbox/Dockerfile", CodexCLIVersion)
	}
}
