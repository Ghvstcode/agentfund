// Package sandbox runs untrusted agent work in Docker: a per-run internal
// network, an egress-proxy sidecar that is the only route out, and a locked
// down sandbox container. It never bind-mounts host paths and never exposes
// the Docker socket. Docker is driven through the CLI behind a small
// interface so the argument construction can be tested without a daemon.
package sandbox

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
)

// Engine abstracts the container CLI.
type Engine interface {
	// Output runs `docker args...` and returns trimmed stdout.
	Output(ctx context.Context, args ...string) (string, error)
	// Stream runs `docker args...` with the given streams. extraEnv is added to
	// the CLI process environment (never to argv) — this is how secrets reach
	// `docker exec -e NAME` without appearing in any process listing.
	Stream(ctx context.Context, in io.Reader, out, errw io.Writer, extraEnv []string, args ...string) (exitCode int, err error)
}

// CLI is the docker (or compatible) command-line client.
type CLI struct{ Bin string }

func (c CLI) bin() string {
	if c.Bin == "" {
		return "docker"
	}
	return c.Bin
}

// Output implements Engine.
func (c CLI) Output(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, c.bin(), args...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return strings.TrimSpace(out.String()), fmt.Errorf("%s %s: %w: %s", c.bin(), summarize(args), err, strings.TrimSpace(errb.String()))
	}
	return strings.TrimSpace(out.String()), nil
}

// Stream implements Engine.
func (c CLI) Stream(ctx context.Context, in io.Reader, out, errw io.Writer, extraEnv []string, args ...string) (int, error) {
	cmd := exec.CommandContext(ctx, c.bin(), args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = in, out, errw
	if len(extraEnv) > 0 {
		cmd.Env = append(os.Environ(), extraEnv...)
	}
	err := cmd.Run()
	if err == nil {
		return 0, nil
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode(), nil
	}
	return -1, fmt.Errorf("%s %s: %w", c.bin(), summarize(args), err)
}

func summarize(args []string) string {
	if len(args) > 3 {
		return strings.Join(args[:3], " ") + " …"
	}
	return strings.Join(args, " ")
}
