package config

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/ghvstcode/agentfund/worker/internal/app"
)

// Default image references. A build from the checkout uses the names the repository's own
// Dockerfiles are built under (`make -C worker images`):
//
//	images/sandbox       -> agentfund/sandbox:dev
//	images/egress-proxy  -> agentfund/egress-proxy:dev
//
// A released binary has the digests of the images published with it stamped in by the linker
// (.goreleaser.yaml, set by the release workflow), e.g.
// ghcr.io/ghvstcode/agentfund-sandbox@sha256:<digest>. A tag can be re-pointed by whoever
// controls the registry (or the local image store); a digest cannot. `agentfund version`
// prints both.
var (
	DefaultSandboxImage     = "agentfund/sandbox:dev"
	DefaultEgressProxyImage = "agentfund/egress-proxy:dev"
)

// Sandbox configures the container the agent runs in.
type Sandbox struct {
	Image            string   `yaml:"image"`
	EgressProxyImage string   `yaml:"egress_proxy_image"`
	CPUs             string   `yaml:"cpus"`
	Memory           string   `yaml:"memory"`
	PIDs             int      `yaml:"pids"`
	AllowGitHost     bool     `yaml:"allow_git_host"`
	ExtraAllowHosts  []string `yaml:"extra_allow_hosts"`
	PassEnv          []string `yaml:"pass_env"`
	// ExtraCACerts is a PEM file of CA certificates the agent trusts besides
	// the image's roots ("" = none). See ReadCACerts.
	ExtraCACerts string `yaml:"extra_ca_certs"`
	Docker       string `yaml:"docker"`
}

// Runner configures the coding agent.
type Runner struct {
	Name  string `yaml:"name"`
	Model string `yaml:"model"`
	// TokenCommand prints the agent's credential when none is in the
	// environment. For claude-code it falls back to global.claude_token_command.
	TokenCommand string `yaml:"token_command"`
}

// Runners are the coding agents the worker can drive. "codex" is experimental.
var Runners = []string{"claude-code", "codex"}

// AgentTokenCommand is the credential command for the configured runner.
func (g Global) AgentTokenCommand() string {
	if g.Runner.TokenCommand != "" {
		return g.Runner.TokenCommand
	}
	if g.Runner.Name == "claude-code" {
		return g.ClaudeTokenCommand
	}
	return ""
}

// Global holds the donor-wide policy.
type Global struct {
	TokensPerDay               Tokens   `yaml:"tokens_per_day"`
	TokensPerWeek              Tokens   `yaml:"tokens_per_week"`
	MaxTokensPerTask           Tokens   `yaml:"max_tokens_per_task"`
	NewProjectMaxTokensPerTask Tokens   `yaml:"new_project_max_tokens_per_task"`
	Schedule                   []string `yaml:"schedule"`
	MaxConcurrent              int      `yaml:"max_concurrent"`
	AllowedGitHosts            []string `yaml:"allowed_git_hosts"`
	AutoFollowSignedUpdates    bool     `yaml:"auto_follow_signed_updates"`
	FollowUnchangedLock        bool     `yaml:"follow_unchanged_lock"`
	RetryFailedAfter           string   `yaml:"retry_failed_after"`
	ClaudeTokenCommand         string   `yaml:"claude_token_command"`
	Sandbox                    Sandbox  `yaml:"sandbox"`
	Runner                     Runner   `yaml:"runner"`
}

// Project is one approved project: the pin plus optional overrides.
type Project struct {
	Server             string    `yaml:"server"`
	Slug               string    `yaml:"slug"`
	Pubkey             string    `yaml:"pubkey"`
	ApprovedCommit     string    `yaml:"approved_commit"`
	ApprovedLockSHA256 string    `yaml:"approved_lock_sha256"`
	ApprovedAt         time.Time `yaml:"approved_at"`
	APIKeyEnv          string    `yaml:"api_key_env,omitempty"`

	// Optional per-project overrides of the global policy. They can only be
	// combined with the global caps, never exceed them (see policy package).
	TokensPerDay            *Tokens   `yaml:"tokens_per_day,omitempty"`
	TokensPerWeek           *Tokens   `yaml:"tokens_per_week,omitempty"`
	MaxTokensPerTask        *Tokens   `yaml:"max_tokens_per_task,omitempty"`
	Schedule                *[]string `yaml:"schedule,omitempty"`
	AutoFollowSignedUpdates *bool     `yaml:"auto_follow_signed_updates,omitempty"`
	FollowUnchangedLock     *bool     `yaml:"follow_unchanged_lock,omitempty"`
}

// Config is config.yaml.
type Config struct {
	Global   Global              `yaml:"global"`
	Projects map[string]*Project `yaml:"projects"`
}

// Default returns the conservative defaults.
func Default() *Config {
	return &Config{
		Global: Global{
			TokensPerDay:               10_000_000,
			TokensPerWeek:              40_000_000,
			MaxTokensPerTask:           5_000_000,
			NewProjectMaxTokensPerTask: 5_000_000,
			Schedule:                   []string{},
			MaxConcurrent:              1,
			AllowedGitHosts:            []string{"github.com"},
			RetryFailedAfter:           "24h",
			Sandbox: Sandbox{
				Image: DefaultSandboxImage, EgressProxyImage: DefaultEgressProxyImage,
				CPUs: "2", Memory: "4g", PIDs: 512,
				ExtraAllowHosts: []string{}, PassEnv: []string{}, Docker: "docker",
			},
			Runner: Runner{Name: "claude-code"},
		},
		Projects: map[string]*Project{},
	}
}

// Load reads config.yaml over the defaults. A missing file yields the defaults.
func Load() (*Config, error) { return LoadFile(Path()) }

// LoadFile reads the given file over the defaults.
func LoadFile(path string) (*Config, error) {
	c := Default()
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	if err := dec.Decode(c); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if c.Projects == nil {
		c.Projects = map[string]*Project{}
	}
	// "" means this binary's own images, so an upgrade brings the images released with it.
	if c.Global.Sandbox.Image == "" {
		c.Global.Sandbox.Image = DefaultSandboxImage
	}
	if c.Global.Sandbox.EgressProxyImage == "" {
		c.Global.Sandbox.EgressProxyImage = DefaultEgressProxyImage
	}
	if err := c.Validate(); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return c, nil
}

var envNameRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// Validate rejects configurations the worker cannot run safely.
func (c *Config) Validate() error {
	g := c.Global
	if g.MaxConcurrent < 1 || g.MaxConcurrent > 16 {
		return fmt.Errorf("global.max_concurrent must be between 1 and 16")
	}
	if g.Sandbox.Image == "" || g.Sandbox.EgressProxyImage == "" {
		return fmt.Errorf("global.sandbox.image and egress_proxy_image must be set")
	}
	if !slices.Contains(Runners, g.Runner.Name) {
		return fmt.Errorf("global.runner.name %q is not supported (one of: %s)", g.Runner.Name, strings.Join(Runners, ", "))
	}
	if _, err := g.RetryDelay(); err != nil {
		return err
	}
	for _, n := range g.Sandbox.PassEnv {
		if !envNameRE.MatchString(n) {
			return fmt.Errorf("global.sandbox.pass_env: %q is not an environment variable name", n)
		}
	}
	for _, h := range g.Sandbox.ExtraAllowHosts {
		if h == "" || strings.ContainsAny(h, " ,/*") {
			return fmt.Errorf("global.sandbox.extra_allow_hosts: %q is not host[:port]", h)
		}
	}
	if g.Sandbox.ExtraCACerts != "" {
		if _, err := ReadCACerts(g.Sandbox.ExtraCACerts); err != nil {
			return err
		}
	}
	for key, p := range c.Projects {
		if p == nil || p.Server == "" || p.Slug == "" {
			return fmt.Errorf("projects[%s]: server and slug are required", key)
		}
		if p.APIKeyEnv != "" && !envNameRE.MatchString(p.APIKeyEnv) {
			return fmt.Errorf("projects[%s].api_key_env is not an environment variable name", key)
		}
	}
	return nil
}

// RetryDelay parses retry_failed_after ("" or "0" = retry immediately).
func (g Global) RetryDelay() (time.Duration, error) {
	if g.RetryFailedAfter == "" || g.RetryFailedAfter == "0" {
		return 0, nil
	}
	d, err := time.ParseDuration(g.RetryFailedAfter)
	if err != nil || d < 0 {
		return 0, fmt.Errorf("global.retry_failed_after: %q is not a duration like 24h or 90m", g.RetryFailedAfter)
	}
	return d, nil
}

// Ref identifies a project on an instance.
type Ref struct {
	Server string // base URL without trailing slash
	Slug   string
}

// Key is the global project id "<server>/<slug>" used as the config key.
func (r Ref) Key() string { return r.Server + "/" + r.Slug }

var slugRE = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

// ParseRef parses "<server-url>/<slug>".
func ParseRef(s string) (Ref, error) {
	u, err := url.Parse(strings.TrimSpace(s))
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return Ref{}, fmt.Errorf("%q is not of the form https://server/project-slug", s)
	}
	p := strings.Trim(u.Path, "/")
	i := strings.LastIndex(p, "/")
	slug, prefix := p[i+1:], ""
	if i >= 0 {
		prefix = "/" + p[:i]
	}
	if !slugRE.MatchString(slug) {
		return Ref{}, fmt.Errorf("%q does not end in a valid project slug", s)
	}
	return Ref{Server: u.Scheme + "://" + u.Host + prefix, Slug: slug}, nil
}

// NormalizeServer trims a server base URL.
func NormalizeServer(s string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(s))
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return "", fmt.Errorf("%q is not a server URL", s)
	}
	return u.Scheme + "://" + u.Host + strings.TrimRight(u.Path, "/"), nil
}

// Resolve finds an approved project by full ref or by a slug that is unique in the config.
func (c *Config) Resolve(arg string) (Ref, *Project, error) {
	if strings.Contains(arg, "://") {
		ref, err := ParseRef(arg)
		if err != nil {
			return Ref{}, nil, err
		}
		p, ok := c.Projects[ref.Key()]
		if !ok {
			return ref, nil, fmt.Errorf("project %s is not approved; run `%s approve %s` first", ref.Key(), app.BinaryName, ref.Key())
		}
		return ref, p, nil
	}
	var matches []string
	for key, p := range c.Projects {
		if p.Slug == arg {
			matches = append(matches, key)
		}
	}
	sort.Strings(matches)
	switch len(matches) {
	case 0:
		return Ref{}, nil, fmt.Errorf("no approved project with slug %q; run `%s approve <server-url>/%s` first", arg, app.BinaryName, arg)
	case 1:
		p := c.Projects[matches[0]]
		return Ref{Server: p.Server, Slug: p.Slug}, p, nil
	}
	return Ref{}, nil, fmt.Errorf("slug %q is ambiguous (%s); use the full <server-url>/<slug>", arg, strings.Join(matches, ", "))
}

// Save writes the config atomically with explanatory comments (0600).
func (c *Config) Save() error { return c.SaveFile(Path()) }

// SaveFile writes the config to path.
func (c *Config) SaveFile(path string) error {
	if err := c.Validate(); err != nil {
		return err
	}
	out, err := c.render()
	if err != nil {
		return err
	}
	return writeFileAtomic(path, out, 0o600)
}

func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

func yamlList(items []string) string {
	if len(items) == 0 {
		return "[]"
	}
	q := make([]string, len(items))
	for i, s := range items {
		q[i] = fmt.Sprintf("%q", s)
	}
	return "[" + strings.Join(q, ", ") + "]"
}

func (c *Config) render() ([]byte, error) {
	g := c.Global
	var b strings.Builder
	w := func(format string, a ...any) { fmt.Fprintf(&b, format, a...) }
	w("# %s worker configuration. Written by `%s approve`; edit freely.\n", app.AppName, app.BinaryName)
	w("# The comments in this file are regenerated whenever the worker saves it.\n")
	w("# Token amounts accept plain integers or k/m/g suffixes (750k, 5M, 200M; case does not matter). 0 = no cap.\n\n")
	w("global:\n")
	w("  # Most tokens the worker may spend per local calendar day, across all projects.\n")
	w("  # A task's full max_tokens is reserved before it starts and settled to the\n")
	w("  # actual usage afterwards, so the cap cannot be overshot.\n")
	w("  tokens_per_day: %s\n", g.TokensPerDay.yamlForm())
	w("  # Same, per local calendar week (Monday 00:00 to Monday 00:00).\n")
	w("  tokens_per_week: %s\n", g.TokensPerWeek.yamlForm())
	w("  # Ceiling for a single task: manifests whose max_tokens is above this are refused.\n")
	w("  max_tokens_per_task: %s\n", g.MaxTokensPerTask.yamlForm())
	w("  # Stricter ceiling while the server reports the project's trust tier as \"new\".\n")
	w("  # The worker uses the minimum of this, max_tokens_per_task and the caps the\n")
	w("  # server publishes; nothing the server says can loosen your policy.\n")
	w("  new_project_max_tokens_per_task: %s\n", g.NewProjectMaxTokensPerTask.yamlForm())
	w("  # Local-time windows in which new tasks may start, e.g. [\"02:00-06:00\"] or\n")
	w("  # [\"22:00-06:00\"] (wraps past midnight). [] = any time. A task that is already\n")
	w("  # running is not interrupted when a window closes.\n")
	w("  schedule: %s\n", yamlList(g.Schedule))
	w("  # How many tasks may run at once.\n")
	w("  max_concurrent: %d\n", g.MaxConcurrent)
	w("  # Git hosts the worker may clone from and publish to. A claim whose repo_url\n")
	w("  # is on another host is released. The entry \"file\" allows file:// URLs (tests).\n")
	w("  allowed_git_hosts: %s\n", yamlList(g.AllowedGitHosts))
	w("  # false (default): only the commit you approved and its ancestors may run.\n")
	w("  # true: also run any newer commit whose task lock is validly signed by the key\n")
	w("  # you pinned (or a key it rotated to) — i.e. new prompts run WITHOUT your review.\n")
	w("  auto_follow_signed_updates: %t\n", g.AutoFollowSignedUpdates)
	w("  # true: also run newer commits whose MANIFEST.lock is byte-identical to the one\n")
	w("  # you approved (the reviewed prompts are unchanged; only code moved).\n")
	w("  follow_unchanged_lock: %t\n", g.FollowUnchangedLock)
	w("  # After a task ended failed, timed out, hit its token cap or was discarded on this\n")
	w("  # machine, do not claim the same task again for this long (it returns to the queue\n")
	w("  # and would otherwise be retried immediately, burning tokens on the same failure).\n")
	w("  retry_failed_after: %q\n", g.RetryFailedAfter)
	w("  # Optional shell command printing a Claude Code OAuth token on stdout, used when\n")
	w("  # neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY is set in the environment.\n")
	w("  # The worker never stores credentials for the coding agent; it reads them from\n")
	w("  # your environment (or this command) at run time and passes them to the sandbox.\n")
	w("  claude_token_command: %q\n", g.ClaudeTokenCommand)
	w("  sandbox:\n")
	w("    # Sandbox image the agent runs in. \"\" = the one this binary was released with\n")
	w("    # (`%s version` names it). Your own: pin it by digest (name@sha256:...).\n", app.BinaryName)
	w("    image: %q\n", unlessDefault(g.Sandbox.Image, DefaultSandboxImage))
	w("    # Egress proxy sidecar image; the only route from the sandbox to the network.\n")
	w("    egress_proxy_image: %q\n", unlessDefault(g.Sandbox.EgressProxyImage, DefaultEgressProxyImage))
	w("    # CPU limit of the sandbox container (docker --cpus).\n")
	w("    cpus: %q\n", g.Sandbox.CPUs)
	w("    # Memory limit of the sandbox container (docker --memory).\n")
	w("    memory: %q\n", g.Sandbox.Memory)
	w("    # Maximum number of processes in the sandbox (docker --pids-limit).\n")
	w("    pids: %d\n", g.Sandbox.PIDs)
	w("    # false (default): the sandbox can reach only the model API (api.anthropic.com,\n")
	w("    # or api.openai.com for codex).\n")
	w("    # The sandbox has no .git and no git credentials; turn on only if a project's\n")
	w("    # verify step must fetch from the git host.\n")
	w("    allow_git_host: %t\n", g.Sandbox.AllowGitHost)
	w("    # Extra host[:port] entries the sandbox may reach besides the model API\n")
	w("    # (api.anthropic.com, or api.openai.com for codex). Keep this empty unless needed.\n")
	w("    extra_allow_hosts: %s\n", yamlList(g.Sandbox.ExtraAllowHosts))
	w("    # Names of additional environment variables to pass from your shell into the\n")
	w("    # agent process (e.g. ANTHROPIC_BASE_URL, CLAUDE_CODE_USE_BEDROCK, AWS_REGION).\n")
	w("    # Their hosts are NOT reachable unless you also list them in extra_allow_hosts.\n")
	w("    pass_env: %s\n", yamlList(g.Sandbox.PassEnv))
	w("    # Optional PEM file of extra CA certificates the agent should trust, e.g. the CA\n")
	w("    # of a TLS-inspecting corporate proxy (absolute path or ~/...). Only CERTIFICATE\n")
	w("    # blocks are allowed. Copied into the sandbox at start and added to its roots.\n")
	w("    extra_ca_certs: %q\n", g.Sandbox.ExtraCACerts)
	w("    # Docker CLI binary.\n")
	w("    docker: %q\n", g.Sandbox.Docker)
	w("  runner:\n")
	w("    # Coding agent to run: \"claude-code\" (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY)\n")
	w("    # or \"codex\" (EXPERIMENTAL; CODEX_API_KEY or OPENAI_API_KEY). Codex reports usage\n")
	w("    # only when it finishes, so a Codex run can end above a task's max_tokens.\n")
	w("    name: %q\n", g.Runner.Name)
	w("    # Optional model alias or id passed to the agent (--model). \"\" = its default.\n")
	w("    model: %q\n", g.Runner.Model)
	w("    # Optional shell command printing the agent's credential on stdout, used when\n")
	w("    # none is in the environment. \"\" = claude_token_command for claude-code.\n")
	w("    token_command: %q\n", g.Runner.TokenCommand)
	w("\n# Approved projects, keyed by <server-url>/<slug>. `pubkey`, `approved_commit` and\n")
	w("# `approved_lock_sha256` are what you reviewed; the worker trusts nothing else.\n")
	w("# Optional per-project overrides: tokens_per_day, tokens_per_week,\n")
	w("# max_tokens_per_task, schedule, auto_follow_signed_updates, follow_unchanged_lock,\n")
	w("# and api_key_env (name of an environment variable holding this server's af_ key).\n")
	if len(c.Projects) == 0 {
		w("projects: {}\n")
		return []byte(b.String()), nil
	}
	pj, err := yaml.Marshal(map[string]any{"projects": c.Projects})
	if err != nil {
		return nil, err
	}
	b.Write(pj)
	return []byte(b.String()), nil
}

// unlessDefault is v, or "" when v is the binary's default: a saved config must not pin the
// images of the binary that happened to write it.
func unlessDefault(v, def string) string {
	if v == def {
		return ""
	}
	return v
}

// Credentials is credentials.yaml: server API keys (af_…), keyed by server URL.
// It never holds credentials for the coding agent.
type Credentials struct {
	Servers map[string]ServerCredential `yaml:"servers"`
}

// ServerCredential is one server's API key.
type ServerCredential struct {
	APIKey string `yaml:"api_key"`
}

// LoadCredentials reads credentials.yaml (missing file = empty).
func LoadCredentials() (*Credentials, error) {
	c := &Credentials{Servers: map[string]ServerCredential{}}
	raw, err := os.ReadFile(CredentialsPath())
	if errors.Is(err, fs.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read credentials: %w", err)
	}
	if err := yaml.Unmarshal(raw, c); err != nil {
		return nil, fmt.Errorf("%s: %w", CredentialsPath(), err)
	}
	if c.Servers == nil {
		c.Servers = map[string]ServerCredential{}
	}
	return c, nil
}

// Save writes credentials.yaml with mode 0600.
func (c *Credentials) Save() error {
	out, err := yaml.Marshal(c)
	if err != nil {
		return err
	}
	header := "# " + app.AppName + " server API keys. Keep this file private (0600).\n"
	return writeFileAtomic(CredentialsPath(), append([]byte(header), out...), 0o600)
}

// APIKey resolves the server API key for a project: the project's
// api_key_env, then $AGENTFUND_API_KEY, then credentials.yaml.
func APIKey(server string, p *Project) (string, error) {
	if p != nil && p.APIKeyEnv != "" {
		if v := os.Getenv(p.APIKeyEnv); v != "" {
			return v, nil
		}
		return "", fmt.Errorf("environment variable %s (api_key_env) is empty", p.APIKeyEnv)
	}
	if v := os.Getenv(EnvAPIKey); v != "" {
		return v, nil
	}
	creds, err := LoadCredentials()
	if err != nil {
		return "", err
	}
	if c, ok := creds.Servers[server]; ok && c.APIKey != "" {
		return c.APIKey, nil
	}
	return "", fmt.Errorf("no API key for %s: run `%s login %s` or set %s", server, app.BinaryName, server, EnvAPIKey)
}
