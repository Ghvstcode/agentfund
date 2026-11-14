// Package cli implements the agentfund command line.
package cli

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"golang.org/x/term"

	"github.com/agentfund/agentfund/worker/internal/app"
	"github.com/agentfund/agentfund/worker/internal/pipeline"
)

// Exit codes.
const (
	ExitOK        = 0
	ExitError     = 1
	ExitUsage     = 2
	ExitNothing   = 3 // work --once: nothing could be started
	ExitNotDone   = 4 // work --once: a task ran but did not complete
	ExitInterrupt = 130
)

type exitError struct {
	code int
	err  error
}

func (e *exitError) Error() string { return e.err.Error() }
func (e *exitError) Unwrap() error { return e.err }

func exitWith(code int, format string, a ...any) error {
	return &exitError{code: code, err: fmt.Errorf(format, a...)}
}

type env struct {
	in       io.Reader
	out, err io.Writer
	reader   *bufio.Reader
}

func (e *env) stdin() *bufio.Reader {
	if e.reader == nil {
		e.reader = bufio.NewReader(e.in)
	}
	return e.reader
}

func (e *env) isTerminal() bool {
	f, ok := e.in.(*os.File)
	o, ok2 := e.out.(*os.File)
	return ok && ok2 && term.IsTerminal(int(f.Fd())) && term.IsTerminal(int(o.Fd()))
}

// readSecret reads one line without echo when stdin is a terminal.
func (e *env) readSecret(prompt string) (string, error) {
	if f, ok := e.in.(*os.File); ok && term.IsTerminal(int(f.Fd())) {
		fmt.Fprint(e.err, prompt)
		b, err := term.ReadPassword(int(f.Fd()))
		fmt.Fprintln(e.err)
		return strings.TrimSpace(string(b)), err
	}
	line, err := e.stdin().ReadString('\n')
	if err != nil && line == "" {
		return "", err
	}
	return strings.TrimSpace(line), nil
}

func (e *env) confirm(question string) (bool, error) {
	fmt.Fprintf(e.out, "%s [y/N]: ", question)
	line, err := e.stdin().ReadString('\n')
	if err != nil && line == "" {
		return false, errors.New("no answer on stdin (use --yes to approve non-interactively)")
	}
	a := strings.ToLower(strings.TrimSpace(line))
	return a == "yes" || a == "y", nil
}

const welcome = app.AppName + ` — back open-source projects with coding-agent work.

Projects publish signed tasks; you review them once, and this tool runs them
in a locked-down sandbox on your machine, under your own coding-agent
credentials and within the caps you set. Results arrive as pull requests.

To back a project:
  ` + app.BinaryName + ` login <server-url>              store the server's API key (or --via <home-server-url>)
  ` + app.BinaryName + ` approve <server-url>/<project>  read every task, pin the maintainer's key
  ` + app.BinaryName + ` dry-run <project>               see what would run, and why not
  ` + app.BinaryName + ` work <project>                  run tasks (Ctrl-C releases them)
  also: status · logs · daemon install · daemon uninstall

To offer your project's tasks (maintainers):
  ` + app.BinaryName + ` keygen                          create a signing key
  ` + app.BinaryName + ` validate tasks/                 check and lint the manifests
  ` + app.BinaryName + ` sign tasks/                     write the signed task lock

` + app.BinaryName + ` <command> --help explains each one; ` + app.BinaryName + ` --help lists everything.
`

// Main runs the CLI and returns the process exit code.
func Main(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	e := &env{in: stdin, out: stdout, err: stderr}
	root := &cobra.Command{
		Use:   app.BinaryName,
		Short: app.AppName + " worker: run signed, sandboxed coding-agent tasks for open-source projects",
		Long: app.AppName + ` lets you donate coding-agent work to open-source projects.

Maintainers:  keygen → validate → sign
Donors:       login → approve → dry-run → work   (status, logs, daemon install)`,
		SilenceUsage:  true,
		SilenceErrors: true,
		Version:       fmt.Sprintf("%s (commit %s, built %s)", app.Version, app.Commit, app.Date),
		Args:          cobra.NoArgs,
		Run:           func(*cobra.Command, []string) { fmt.Fprint(stdout, welcome) },
	}
	root.SetArgs(args)
	root.SetIn(stdin)
	root.SetOut(stdout)
	root.SetErr(stderr)
	root.AddCommand(
		keygenCmd(e), signCmd(e), validateCmd(e),
		loginCmd(e), approveCmd(e), workCmd(e), dryRunCmd(e), statusCmd(e), logsCmd(e), daemonCmd(e),
		&cobra.Command{Use: "version", Short: "Print the version", Args: cobra.NoArgs, Run: func(*cobra.Command, []string) {
			fmt.Fprintf(stdout, "%s %s (commit %s, built %s)\n", app.BinaryName, app.Version, app.Commit, app.Date)
		}},
	)
	err := root.Execute()
	if err == nil {
		return ExitOK
	}
	var ee *exitError
	if errors.As(err, &ee) {
		if ee.err != nil && ee.err.Error() != "" {
			fmt.Fprintf(stderr, "%s: %v\n", app.BinaryName, ee.err)
		}
		return ee.code
	}
	fmt.Fprintf(stderr, "%s: %v\n", app.BinaryName, err)
	var fatal *pipeline.ErrFatal
	if errors.As(err, &fatal) {
		return ExitError
	}
	if strings.Contains(err.Error(), "unknown command") || strings.Contains(err.Error(), "unknown flag") ||
		strings.Contains(err.Error(), "accepts ") || strings.Contains(err.Error(), "requires ") || strings.Contains(err.Error(), "invalid argument") {
		return ExitUsage
	}
	return ExitError
}
