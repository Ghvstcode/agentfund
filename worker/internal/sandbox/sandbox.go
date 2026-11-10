package sandbox

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ghvstcode/agentfund/worker/internal/app"
)

// Fixed properties of the sandbox image (images/sandbox/Dockerfile).
const (
	WorkDir   = "/work"
	WorkRoot  = "work" // name of the root entry in `docker cp <c>:/work -`
	AgentUser = "10001:10001"
	AgentHome = "/home/agent"
	ProxyPort = "3128"
	// ProxyAlias is the DNS name of the sidecar on the internal network.
	ProxyAlias = "egress-proxy"

	// The donor's extra CA certificates (Spec.ExtraCACerts) live in a
	// root-owned tmpfs: ExtraCAFile holds them alone (NODE_EXTRA_CA_CERTS adds
	// it to Node's roots), CABundleFile holds the image's roots plus them
	// (some clients read SSL_CERT_FILE in place of their roots: Codex's
	// WebSocket, OpenSSL, Go).
	CADir          = "/etc/agentfund/ca"
	ExtraCAFile    = CADir + "/extra.pem"
	CABundleFile   = CADir + "/bundle.pem"
	SystemCABundle = "/etc/ssl/certs/ca-certificates.crt"

	// Labels attached to every resource the worker creates.
	LabelRun = app.LabelPrefix + ".run"
	LabelPID = app.LabelPrefix + ".pid"
)

// Spec describes one sandbox.
type Spec struct {
	RunID      string // unique, [a-z0-9-]
	Image      string
	ProxyImage string
	CPUs       string
	Memory     string
	PIDs       int
	// AllowHosts is the egress allowlist, host[:port] (port defaults to 443).
	AllowHosts []string
	// ExtraCACerts are PEM certificates the agent trusts besides the image's
	// roots (nil = none). They are copied in, not bind-mounted, so this works
	// whichever host paths the Docker engine can see.
	ExtraCACerts []byte
}

var (
	runIDRE = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{2,62}$`)
	hostRE  = regexp.MustCompile(`^(\*\.)?[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$`)
	imageRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/:@-]*$`)
	limitRE = regexp.MustCompile(`^[0-9]+(\.[0-9]+)?[a-zA-Z]{0,2}$`)
)

func (s Spec) validate() error {
	if !runIDRE.MatchString(s.RunID) {
		return fmt.Errorf("sandbox: bad run id %q", s.RunID)
	}
	if !imageRE.MatchString(s.Image) || !imageRE.MatchString(s.ProxyImage) {
		return fmt.Errorf("sandbox: bad image reference")
	}
	if !limitRE.MatchString(s.CPUs) || !limitRE.MatchString(s.Memory) || s.PIDs < 16 {
		return fmt.Errorf("sandbox: cpus, memory and pids limits are required (got %q, %q, %d)", s.CPUs, s.Memory, s.PIDs)
	}
	for _, h := range s.AllowHosts {
		if !hostRE.MatchString(h) {
			return fmt.Errorf("sandbox: bad egress allowlist entry %q", h)
		}
	}
	if len(s.ExtraCACerts) > 0 && (!bytes.HasPrefix(s.ExtraCACerts, []byte("-----BEGIN CERTIFICATE-----")) || bytes.Contains(s.ExtraCACerts, []byte("PRIVATE KEY"))) {
		return fmt.Errorf("sandbox: extra CA certificates must be PEM CERTIFICATE blocks only")
	}
	return nil
}

// Session is a running sandbox.
type Session struct {
	eng     Engine
	spec    Spec
	network string
	proxy   string
	box     string
	volume  string

	closeOnce sync.Once
}

func (s Spec) names() (network, proxy, box, volume string) {
	base := app.LabelPrefix + "-" + s.RunID
	return base + "-net", base + "-proxy", base + "-sbx", base + "-work"
}

func labels(runID string) []string {
	return []string{"--label", LabelRun + "=" + runID, "--label", LabelPID + "=" + strconv.Itoa(os.Getpid())}
}

// proxyArgs builds `docker create` arguments for the egress sidecar.
func proxyArgs(s Spec) []string {
	_, proxy, _, _ := s.names()
	args := []string{"create", "--name", proxy}
	args = append(args, labels(s.RunID)...)
	args = append(args,
		"--network", "bridge",
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
		"--read-only",
		"--pids-limit", "256",
		"--memory", "256m",
		"--restart", "no",
		"-e", "ALLOW_HOSTS="+strings.Join(s.AllowHosts, ","),
		s.ProxyImage,
	)
	return args
}

// boxArgs builds `docker run` arguments for the sandbox container.
func boxArgs(s Spec) []string {
	network, _, box, volume := s.names()
	proxyURL := "http://" + ProxyAlias + ":" + ProxyPort
	args := []string{"run", "-d", "--name", box}
	args = append(args, labels(s.RunID)...)
	args = append(args,
		"--network", network, // internal network only: no route out except the proxy
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
		"--pids-limit", strconv.Itoa(s.PIDs),
		"--cpus", s.CPUs,
		"--memory", s.Memory,
		"--read-only",
		"--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=4g,mode=1777",
		"--tmpfs", AgentHome+":rw,exec,nosuid,nodev,size=2g,uid=10001,gid=10001,mode=0700",
		"--mount", "type=volume,src="+volume+",dst="+WorkDir,
	)
	if len(s.ExtraCACerts) > 0 {
		args = append(args,
			"--tmpfs", CADir+":rw,noexec,nosuid,nodev,size=4m,mode=0755", // root-owned: the agent can read, not write
			"-e", "NODE_EXTRA_CA_CERTS="+ExtraCAFile, "-e", "SSL_CERT_FILE="+CABundleFile,
		)
	}
	args = append(args,
		"--user", AgentUser,
		"--workdir", WorkDir,
		"--init",
		"--restart", "no",
		"-e", "HOME="+AgentHome,
		"-e", "HTTPS_PROXY="+proxyURL, "-e", "HTTP_PROXY="+proxyURL,
		"-e", "https_proxy="+proxyURL, "-e", "http_proxy="+proxyURL,
		"-e", "NO_PROXY=", "-e", "no_proxy=",
		"--entrypoint", "sleep",
		s.Image, "infinity",
	)
	return args
}

// Start creates the network, sidecar, volume and sandbox container. On any
// failure everything created so far is removed.
func Start(ctx context.Context, eng Engine, spec Spec) (*Session, error) {
	if err := spec.validate(); err != nil {
		return nil, err
	}
	network, proxy, box, volume := spec.names()
	s := &Session{eng: eng, spec: spec, network: network, proxy: proxy, box: box, volume: volume}
	steps := []struct {
		what string
		args []string
	}{
		{"create internal network", append(append([]string{"network", "create", "--internal"}, labels(spec.RunID)...), network)},
		{"create egress proxy", proxyArgs(spec)},
		{"attach egress proxy to the internal network", []string{"network", "connect", "--alias", ProxyAlias, network, proxy}},
		{"start egress proxy", []string{"start", proxy}},
		{"create work volume", append(append([]string{"volume", "create"}, labels(spec.RunID)...), volume)},
		{"start sandbox", boxArgs(spec)},
	}
	for _, st := range steps {
		if _, err := eng.Output(ctx, st.args...); err != nil {
			s.Close()
			return nil, fmt.Errorf("sandbox: %s: %w", st.what, err)
		}
	}
	if len(spec.ExtraCACerts) > 0 {
		if err := s.installCACerts(ctx); err != nil {
			s.Close()
			return nil, err
		}
	}
	return s, nil
}

// installCACerts writes the extra certificates and the combined bundle as
// root, before the agent runs, so the agent can read but not change them.
func (s *Session) installCACerts(ctx context.Context) error {
	script := "umask 022 && cat > " + ExtraCAFile + " && cat " + SystemCABundle + " " + ExtraCAFile + " > " + CABundleFile
	var errb bytes.Buffer
	code, err := s.eng.Stream(ctx, bytes.NewReader(s.spec.ExtraCACerts), io.Discard, &errb, nil,
		"exec", "-i", "-u", "0:0", s.box, "sh", "-c", script)
	if err == nil && code != 0 {
		err = fmt.Errorf("exited %d: %s", code, strings.TrimSpace(errb.String()))
	}
	if err != nil {
		return fmt.Errorf("sandbox: install extra CA certificates (the image needs %s): %w", SystemCABundle, err)
	}
	return nil
}

// Container returns the sandbox container name.
func (s *Session) Container() string { return s.box }

// ProxyContainer returns the sidecar container name.
func (s *Session) ProxyContainer() string { return s.proxy }

// PutWorkTree unpacks a tar stream into the working directory, keeping the
// ownership and modes recorded in the archive, then sets the mode of the
// working directory root.
func (s *Session) PutWorkTree(ctx context.Context, tarStream io.Reader, rootWritable bool) error {
	var errb bytes.Buffer
	code, err := s.eng.Stream(ctx, tarStream, io.Discard, &errb, nil, "cp", "-", s.box+":"+WorkDir)
	if err != nil {
		return err
	}
	if code != 0 {
		return fmt.Errorf("sandbox: copy work tree: docker cp exited %d: %s", code, strings.TrimSpace(errb.String()))
	}
	mode := "0755"
	if rootWritable {
		mode = "1777"
	}
	if _, err := s.eng.Output(ctx, "exec", "-u", "0:0", s.box, "chmod", mode, WorkDir); err != nil {
		return fmt.Errorf("sandbox: set work tree mode: %w", err)
	}
	return nil
}

// TarWorkTree streams the working directory out as a tar archive. The caller
// must read it as data and never extract it. wait returns the copy's outcome.
func (s *Session) TarWorkTree(ctx context.Context) (r io.ReadCloser, wait func() error) {
	pr, pw := io.Pipe()
	var errb bytes.Buffer
	done := make(chan error, 1)
	go func() {
		code, err := s.eng.Stream(ctx, nil, pw, &errb, nil, "cp", s.box+":"+WorkDir, "-")
		if err == nil && code != 0 {
			err = fmt.Errorf("sandbox: read work tree: docker cp exited %d: %s", code, strings.TrimSpace(errb.String()))
		}
		pw.CloseWithError(err)
		done <- err
	}()
	return pr, func() error { return <-done }
}

// ExecSpec is one command run inside the sandbox as the unprivileged agent.
type ExecSpec struct {
	Cmd []string
	// PassEnv names variables whose values are taken from Env (or, when absent
	// there, from the worker's own environment) and forwarded by NAME only.
	PassEnv []string
	// Env holds NAME=value pairs for the docker CLI process environment. Values
	// here never appear in argv.
	Env    []string
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
}

var envNameRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func execArgs(box string, es ExecSpec) ([]string, error) {
	args := []string{"exec"}
	if es.Stdin != nil {
		args = append(args, "-i")
	}
	args = append(args, "-u", AgentUser, "-w", WorkDir)
	for _, n := range es.PassEnv {
		if !envNameRE.MatchString(n) {
			return nil, fmt.Errorf("sandbox: %q is not an environment variable name", n)
		}
		args = append(args, "-e", n) // name only: the value is inherited from the CLI's environment
	}
	args = append(args, box)
	if len(es.Cmd) == 0 {
		return nil, errors.New("sandbox: empty command")
	}
	return append(args, es.Cmd...), nil
}

// Exec runs a command in the sandbox and returns its exit code.
func (s *Session) Exec(ctx context.Context, es ExecSpec) (int, error) {
	args, err := execArgs(s.box, es)
	if err != nil {
		return -1, err
	}
	return s.eng.Stream(ctx, es.Stdin, es.Stdout, es.Stderr, es.Env, args...)
}

// Kill stops the sandbox container immediately; every process in it dies.
func (s *Session) Kill() {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	_, _ = s.eng.Output(ctx, "kill", s.box)
}

// ProxyLogs returns the sidecar's JSON log lines (allow/deny decisions).
func (s *Session) ProxyLogs(ctx context.Context) ([]string, error) {
	var out bytes.Buffer
	if _, err := s.eng.Stream(ctx, nil, &out, io.Discard, nil, "logs", s.proxy); err != nil {
		return nil, err
	}
	var lines []string
	for _, l := range strings.Split(out.String(), "\n") {
		if l = strings.TrimSpace(l); l != "" {
			lines = append(lines, l)
		}
	}
	return lines, nil
}

// Close removes the containers, the volume and the network. It is idempotent
// and uses its own context so it also runs after cancellation.
func (s *Session) Close() {
	s.closeOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		_, _ = s.eng.Output(ctx, "rm", "-f", "-v", s.box)
		_, _ = s.eng.Output(ctx, "rm", "-f", "-v", s.proxy)
		_, _ = s.eng.Output(ctx, "volume", "rm", "-f", s.volume)
		_, _ = s.eng.Output(ctx, "network", "rm", s.network)
	})
}

// CleanOrphans removes sandbox resources left behind by worker processes
// that no longer exist (crash, power loss). alive reports whether a pid is a
// live process; resources of live workers are left alone. It returns what was removed.
func CleanOrphans(ctx context.Context, eng Engine, alive func(pid int) bool) ([]string, error) {
	var removed []string
	kinds := []struct {
		list []string
		rm   []string
	}{
		{[]string{"ps", "-a", "--filter", "label=" + LabelRun, "--format", `{{.Names}} {{.Label "` + LabelPID + `"}}`}, []string{"rm", "-f", "-v"}},
		{[]string{"volume", "ls", "--filter", "label=" + LabelRun, "--format", `{{.Name}} {{.Label "` + LabelPID + `"}}`}, []string{"volume", "rm", "-f"}},
		{[]string{"network", "ls", "--filter", "label=" + LabelRun, "--format", `{{.Name}} {{.Label "` + LabelPID + `"}}`}, []string{"network", "rm"}},
	}
	var firstErr error
	for _, k := range kinds {
		out, err := eng.Output(ctx, k.list...)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		for _, line := range strings.Split(out, "\n") {
			f := strings.Fields(line)
			if len(f) == 0 {
				continue
			}
			pid := 0
			if len(f) > 1 {
				pid, _ = strconv.Atoi(f[1])
			}
			if pid != 0 && pid != os.Getpid() && alive(pid) {
				continue
			}
			if pid == os.Getpid() {
				continue
			}
			if _, err := eng.Output(ctx, append(append([]string{}, k.rm...), f[0])...); err == nil {
				removed = append(removed, f[0])
			}
		}
	}
	return removed, firstErr
}

// Available checks that the engine responds and returns its version.
func Available(ctx context.Context, eng Engine) (string, error) {
	v, err := eng.Output(ctx, "version", "--format", "{{.Server.Version}}")
	if err != nil {
		return "", fmt.Errorf("docker is not available: %w", err)
	}
	return v, nil
}

// ImagePresent reports whether an image exists locally.
func ImagePresent(ctx context.Context, eng Engine, ref string) bool {
	_, err := eng.Output(ctx, "image", "inspect", "--format", "{{.Id}}", ref)
	return err == nil
}
