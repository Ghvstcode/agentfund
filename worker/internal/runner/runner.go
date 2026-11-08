// Package runner drives a coding agent inside the sandbox and meters it.
// Runner is the seam between the pipeline and a specific agent CLI: Claude
// Code (CLAUDE_CODE_NOTES.md) and, experimentally, Codex (CODEX_NOTES.md).
package runner

import (
	"context"
	"fmt"
	"io"
	"time"
)

// Usage is cumulative token usage of one run (spec/manifest.md, Metering):
// TokensIn = input + cache-creation + cache-read tokens of every model call,
// TokensOut = output tokens.
type Usage struct {
	TokensIn  int64
	TokensOut int64
	CostUSD   float64
}

// Total is what counts against max_tokens.
func (u Usage) Total() int64 { return u.TokensIn + u.TokensOut }

// Outcome is what a run produced.
type Outcome struct {
	Usage
	// Final is true when Usage comes from the agent's own final accounting
	// rather than from summing the stream.
	Final    bool
	ExitCode int
	Model    string
	Version  string // runner identification, e.g. "claude-code/2.1.289"
	// ResultSeen is true when the agent emitted its terminal result event.
	ResultSeen bool
	// IsError is true when the agent reported failure.
	IsError bool
	Message string
	// RateLimited is set when the provider refused for rate/usage limits (or
	// was overloaded); ResetAt is when the limit lifts, if known.
	RateLimited bool
	ResetAt     time.Time
	// CredentialProblem is set when the provider rejected the donor's
	// credentials or account; continuing to claim tasks would be pointless.
	CredentialProblem string
}

// ExecFunc runs a command inside the sandbox as the unprivileged agent user
// with the repo as working directory. passEnv are variable NAMES forwarded
// into the process; their values come from env (NAME=value pairs given to the
// container CLI's environment) or from the worker's own environment.
type ExecFunc func(ctx context.Context, cmd []string, passEnv, env []string, stdin io.Reader, stdout, stderr io.Writer) (exitCode int, err error)

// RunSpec is one agent invocation.
type RunSpec struct {
	Prompt string // handed to the agent verbatim
	Model  string // optional
	Exec   ExecFunc
	Creds  Credentials
	// OnEvent receives every raw stream line (for the run log).
	OnEvent func(line []byte)
	// OnUsage receives the cumulative usage whenever it changes. The caller
	// enforces max_tokens by cancelling ctx / killing the sandbox.
	OnUsage func(Usage)
	// OnStderr receives agent stderr lines.
	OnStderr func(line []byte)
}

// Credentials are resolved on the host at run time and never stored.
type Credentials struct {
	// PassEnv are the variable names to forward into the agent process.
	PassEnv []string
	// Env are NAME=value pairs that are not in the worker's own environment
	// (e.g. the output of claude_token_command).
	Env []string
	// Secrets are the values to scrub from anything that is logged or reported.
	Secrets []string
}

// New returns the runner with the given config name (see config.Runners).
func New(name string) (Runner, error) {
	switch name {
	case "", "claude-code":
		return NewClaudeCode(), nil
	case "codex":
		return NewCodex(), nil
	}
	return nil, fmt.Errorf("unknown runner %q", name)
}

// Runner is a coding agent.
type Runner interface {
	// Name identifies the runner ("claude-code").
	Name() string
	// APIHosts are the hosts the agent must reach (egress allowlist).
	APIHosts() []string
	// Credentials resolves the donor's credentials from the environment.
	Credentials(ctx context.Context, lookupEnv func(string) (string, bool), tokenCommand string, passEnv []string) (Credentials, error)
	// Run executes the agent and blocks until it exits or ctx is cancelled.
	Run(ctx context.Context, spec RunSpec) (Outcome, error)
}
