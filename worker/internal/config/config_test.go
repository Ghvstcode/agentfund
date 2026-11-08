package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseTokens(t *testing.T) {
	good := map[string]Tokens{
		"200m": 200_000_000, "5M": 5_000_000, "750k": 750_000, "750K": 750_000, "1234": 1234, "0": 0,
		"1.5m": 1_500_000, "2g": 2_000_000_000, "1b": 1_000_000_000, " 10m ": 10_000_000, "1_000_000": 1_000_000, "0.5k": 500,
	}
	for in, want := range good {
		if got, err := ParseTokens(in); err != nil || got != want {
			t.Errorf("ParseTokens(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "m", "-5", "-1m", "five", "1.5", "10mm", "1e9", "NaNm", "99999999999999999999", "9999999999999g"} {
		if got, err := ParseTokens(bad); err == nil {
			t.Errorf("ParseTokens(%q) accepted as %d", bad, got)
		}
	}
	for _, v := range []Tokens{0, 999, 1000, 1500, 750_000, 5_000_000, 1_500_000, 200_000_000, 2_000_000_000, 1_234_567} {
		for _, form := range []string{v.String(), v.yamlForm()} {
			back, err := ParseTokens(form)
			if err != nil || back != v {
				t.Errorf("round trip %d -> %q -> %d (%v)", v, form, back, err)
			}
		}
	}
	if Tokens(10_000_000).String() != "10M" || Tokens(8250).String() != "8,250" || Tokens(8250).yamlForm() != "8250" || Tokens(750_000).yamlForm() != "750k" {
		t.Error("display and config forms")
	}
}

func TestParseRef(t *testing.T) {
	good := map[string]Ref{
		"https://fund.example/gridrs":          {"https://fund.example", "gridrs"},
		"https://fund.example/gridrs/":         {"https://fund.example", "gridrs"},
		"http://localhost:8787/hello-project":  {"http://localhost:8787", "hello-project"},
		"https://fund.example/base/path/proj1": {"https://fund.example/base/path", "proj1"},
	}
	for in, want := range good {
		got, err := ParseRef(in)
		if err != nil || got != want {
			t.Errorf("ParseRef(%q) = %+v, %v", in, got, err)
		}
	}
	for _, bad := range []string{"gridrs", "https://fund.example", "https://fund.example/", "ftp://x/y", "https://x/UPPER", "https://x/a?b=1", "https://u:p@x/a", "https://x/a#frag"} {
		if got, err := ParseRef(bad); err == nil {
			t.Errorf("ParseRef(%q) accepted: %+v", bad, got)
		}
	}
}

func TestConfigRoundTripKeepsCommentsAndValues(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(EnvConfigDir, dir)
	c := Default()
	c.Global.TokensPerDay = 200_000_000
	c.Global.Schedule = []string{"22:00-06:00"}
	c.Global.Sandbox.PassEnv = []string{"ANTHROPIC_BASE_URL"}
	day := Tokens(750_000)
	follow := true
	c.Projects["https://fund.example/gridrs"] = &Project{
		Server: "https://fund.example", Slug: "gridrs", Pubkey: "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3",
		ApprovedCommit: strings.Repeat("a", 40), ApprovedLockSHA256: strings.Repeat("b", 64),
		TokensPerDay: &day, FollowUnchangedLock: &follow,
	}
	if err := c.Save(); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "config.yaml"))
	for _, knob := range []string{"tokens_per_day", "tokens_per_week", "max_tokens_per_task", "new_project_max_tokens_per_task",
		"schedule", "max_concurrent", "allowed_git_hosts", "auto_follow_signed_updates", "follow_unchanged_lock",
		"retry_failed_after", "claude_token_command", "image", "egress_proxy_image", "cpus", "memory", "pids", "allow_git_host", "extra_allow_hosts", "pass_env", "docker", "name", "model"} {
		idx := strings.Index(string(raw), "\n  "+knob+":")
		if idx < 0 {
			idx = strings.Index(string(raw), "\n    "+knob+":")
		}
		if idx < 0 {
			t.Errorf("knob %s missing from rendered config", knob)
			continue
		}
		before := strings.TrimRight(string(raw)[:idx], " ")
		lastLine := before[strings.LastIndex(before, "\n")+1:]
		if !strings.HasPrefix(strings.TrimSpace(lastLine), "#") {
			t.Errorf("knob %s has no explanatory comment above it (found %q)", knob, lastLine)
		}
	}
	if st, _ := os.Stat(filepath.Join(dir, "config.yaml")); st.Mode().Perm() != 0o600 {
		t.Errorf("config mode %v", st.Mode().Perm())
	}
	back, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	p := back.Projects["https://fund.example/gridrs"]
	if back.Global.TokensPerDay != 200_000_000 || back.Global.Schedule[0] != "22:00-06:00" || p == nil ||
		*p.TokensPerDay != 750_000 || !*p.FollowUnchangedLock || p.ApprovedCommit != strings.Repeat("a", 40) ||
		back.Global.Sandbox.PassEnv[0] != "ANTHROPIC_BASE_URL" || back.Global.AutoFollowSignedUpdates || back.Global.FollowUnchangedLock {
		t.Fatalf("round trip lost data: %+v / %+v", back.Global, p)
	}
	if _, _, err := back.Resolve("gridrs"); err != nil {
		t.Errorf("resolve by slug: %v", err)
	}
	if _, _, err := back.Resolve("https://fund.example/gridrs"); err != nil {
		t.Errorf("resolve by ref: %v", err)
	}
	if _, _, err := back.Resolve("nope"); err == nil {
		t.Error("resolved an unknown slug")
	}
	back.Projects["https://other.example/gridrs"] = &Project{Server: "https://other.example", Slug: "gridrs"}
	if _, _, err := back.Resolve("gridrs"); err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Errorf("ambiguous slug: %v", err)
	}
}

func TestDefaultsAreConservative(t *testing.T) {
	t.Setenv(EnvConfigDir, t.TempDir())
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	g := c.Global
	if g.AutoFollowSignedUpdates || g.FollowUnchangedLock || g.MaxConcurrent != 1 || len(g.AllowedGitHosts) != 1 ||
		g.AllowedGitHosts[0] != "github.com" || g.TokensPerDay == 0 || g.TokensPerWeek == 0 || g.MaxTokensPerTask == 0 ||
		g.NewProjectMaxTokensPerTask == 0 || len(g.Sandbox.PassEnv) != 0 || g.Sandbox.AllowGitHost || len(g.Sandbox.ExtraAllowHosts) != 0 {
		t.Fatalf("defaults are not conservative: %+v", g)
	}
}

func TestRunnerSelection(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config.yaml")
	os.WriteFile(p, []byte("global:\n  claude_token_command: claude-cmd\n  runner: {name: codex}\n"), 0o600)
	c, err := LoadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if c.Global.Runner.Name != "codex" || c.Global.AgentTokenCommand() != "" {
		t.Fatalf("codex must not inherit claude_token_command: %+v", c.Global.Runner)
	}
	c.Global.Runner.TokenCommand = "codex-cmd"
	if c.Global.AgentTokenCommand() != "codex-cmd" {
		t.Fatal("runner.token_command ignored")
	}
	c.Global.Runner = Runner{Name: "claude-code"}
	if c.Global.AgentTokenCommand() != "claude-cmd" {
		t.Fatal("claude-code lost claude_token_command")
	}
	// Round trip through the commented writer.
	c.Global.Runner = Runner{Name: "codex", Model: "gpt-5-codex", TokenCommand: "pass show openai"}
	if err := c.SaveFile(p); err != nil {
		t.Fatal(err)
	}
	c2, err := LoadFile(p)
	if err != nil || c2.Global.Runner != c.Global.Runner {
		t.Fatalf("round trip: %+v %v", c2.Global.Runner, err)
	}
}

func TestLoadRejectsUnknownAndInvalid(t *testing.T) {
	for name, body := range map[string]string{
		"unknown knob":   "global:\n  tokens_per_dya: 5m\n",
		"bad tokens":     "global:\n  tokens_per_day: lots\n",
		"bad concurrent": "global:\n  max_concurrent: 0\n",
		"bad runner":     "global:\n  runner: {name: aider}\n",
		"bad pass_env":   "global:\n  sandbox: {pass_env: [\"A=B\"]}\n",
		"bad allow host": "global:\n  sandbox: {extra_allow_hosts: [\"*.example.com\"]}\n",
	} {
		p := filepath.Join(t.TempDir(), "config.yaml")
		os.WriteFile(p, []byte(body), 0o600)
		if _, err := LoadFile(p); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestAPIKeyResolution(t *testing.T) {
	t.Setenv(EnvConfigDir, t.TempDir())
	t.Setenv(EnvAPIKey, "")
	if _, err := APIKey("https://s", nil); err == nil {
		t.Fatal("expected an error without any key")
	}
	creds, _ := LoadCredentials()
	creds.Servers["https://s"] = ServerCredential{APIKey: "af_file"}
	if err := creds.Save(); err != nil {
		t.Fatal(err)
	}
	if st, _ := os.Stat(CredentialsPath()); st.Mode().Perm() != 0o600 {
		t.Fatalf("credentials mode %v", st.Mode().Perm())
	}
	if k, _ := APIKey("https://s", nil); k != "af_file" {
		t.Fatalf("file key: %q", k)
	}
	t.Setenv(EnvAPIKey, "af_env")
	if k, _ := APIKey("https://s", nil); k != "af_env" {
		t.Fatalf("env key: %q", k)
	}
	t.Setenv("MY_KEY", "af_proj")
	if k, _ := APIKey("https://s", &Project{APIKeyEnv: "MY_KEY"}); k != "af_proj" {
		t.Fatalf("project env key: %q", k)
	}
	t.Setenv("MY_KEY", "")
	if _, err := APIKey("https://s", &Project{APIKeyEnv: "MY_KEY"}); err == nil {
		t.Fatal("empty api_key_env must be an error, not a silent fallback")
	}
}
