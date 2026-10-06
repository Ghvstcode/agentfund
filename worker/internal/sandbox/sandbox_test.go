package sandbox

import (
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
)

type fakeEngine struct {
	mu    sync.Mutex
	calls [][]string
	envs  [][]string
	fail  string // substring of the joined args that should fail
	out   map[string]string
}

func (f *fakeEngine) record(args []string, env []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, args)
	f.envs = append(f.envs, env)
	if f.fail != "" && strings.Contains(strings.Join(args, " "), f.fail) {
		return errors.New("boom")
	}
	return nil
}

func (f *fakeEngine) Output(_ context.Context, args ...string) (string, error) {
	if err := f.record(args, nil); err != nil {
		return "", err
	}
	return f.out[args[0]+" "+args[1]], nil
}

func (f *fakeEngine) Stream(_ context.Context, _ io.Reader, _, _ io.Writer, env []string, args ...string) (int, error) {
	return 0, f.record(args, env)
}

func (f *fakeEngine) joined() []string {
	var out []string
	for _, c := range f.calls {
		out = append(out, strings.Join(c, " "))
	}
	return out
}

func spec() Spec {
	return Spec{RunID: "t-0123abcd", Image: "agentfund/sandbox:dev", ProxyImage: "agentfund/egress-proxy:dev",
		CPUs: "2", Memory: "4g", PIDs: 512, AllowHosts: []string{"api.anthropic.com", "github.com"}}
}

func has(args []string, seq ...string) bool {
	for i := 0; i+len(seq) <= len(args); i++ {
		ok := true
		for j := range seq {
			if args[i+j] != seq[j] {
				ok = false
				break
			}
		}
		if ok {
			return true
		}
	}
	return false
}

func TestSandboxContainerIsLockedDown(t *testing.T) {
	args := boxArgs(spec())
	for _, want := range [][]string{
		{"--network", "agentfund-t-0123abcd-net"},
		{"--cap-drop", "ALL"},
		{"--security-opt", "no-new-privileges"},
		{"--pids-limit", "512"},
		{"--cpus", "2"},
		{"--memory", "4g"},
		{"--read-only"},
		{"--user", "10001:10001"},
		{"--workdir", "/work"},
		{"--mount", "type=volume,src=agentfund-t-0123abcd-work,dst=/work"},
		{"-e", "HTTPS_PROXY=http://egress-proxy:3128"},
		{"-e", "HTTP_PROXY=http://egress-proxy:3128"},
		{"--label", "agentfund.run=t-0123abcd"},
	} {
		if !has(args, want...) {
			t.Errorf("sandbox args lack %v\n%v", want, args)
		}
	}
	joined := " " + strings.Join(args, " ") + " "
	for _, forbidden := range []string{" -v ", " --volume", "type=bind", "docker.sock", "--privileged", "--cap-add", "--network host", "--net=host",
		"--pid ", "--pid=", "--ipc", "--device", "--publish", " -p ", "--volumes-from", "seccomp=unconfined", "apparmor=unconfined", "--userns"} {
		if strings.Contains(joined, forbidden) {
			t.Errorf("sandbox args contain %q: %v", forbidden, args)
		}
	}
	if n := strings.Count(joined, "--network "); n != 1 {
		t.Errorf("sandbox must be on exactly one network, found %d", n)
	}
}

func TestProxySidecarArgs(t *testing.T) {
	args := proxyArgs(spec())
	if !has(args, "-e", "ALLOW_HOSTS=api.anthropic.com,github.com") || !has(args, "--network", "bridge") ||
		!has(args, "--cap-drop", "ALL") || args[len(args)-1] != "agentfund/egress-proxy:dev" {
		t.Fatalf("proxy args: %v", args)
	}
	if strings.Contains(strings.Join(args, " "), "ALLOW_PRIVATE_UPSTREAMS") {
		t.Fatal("the production sidecar must never allow private upstreams")
	}
}

func TestStartOrderAndTeardown(t *testing.T) {
	f := &fakeEngine{}
	s, err := Start(context.Background(), f, spec())
	if err != nil {
		t.Fatal(err)
	}
	calls := f.joined()
	wantPrefix := []string{
		"network create --internal",
		"create --name agentfund-t-0123abcd-proxy",
		"network connect --alias egress-proxy agentfund-t-0123abcd-net agentfund-t-0123abcd-proxy",
		"start agentfund-t-0123abcd-proxy",
		"volume create",
		"run -d --name agentfund-t-0123abcd-sbx",
	}
	if len(calls) != len(wantPrefix) {
		t.Fatalf("calls: %v", calls)
	}
	for i, w := range wantPrefix {
		if !strings.HasPrefix(calls[i], w) {
			t.Errorf("step %d = %q, want prefix %q", i, calls[i], w)
		}
	}
	s.Close()
	s.Close() // idempotent
	after := f.joined()[len(calls):]
	want := []string{"rm -f -v agentfund-t-0123abcd-sbx", "rm -f -v agentfund-t-0123abcd-proxy", "volume rm -f agentfund-t-0123abcd-work", "network rm agentfund-t-0123abcd-net"}
	if strings.Join(after, "|") != strings.Join(want, "|") {
		t.Fatalf("teardown: %v", after)
	}
}

func TestStartFailureCleansUp(t *testing.T) {
	for _, failAt := range []string{"network create", "create --name", "network connect", "volume create", "run -d"} {
		f := &fakeEngine{fail: failAt}
		if _, err := Start(context.Background(), f, spec()); err == nil {
			t.Fatalf("%s: expected failure", failAt)
		}
		j := strings.Join(f.joined(), "|")
		for _, want := range []string{"rm -f -v agentfund-t-0123abcd-sbx", "network rm agentfund-t-0123abcd-net", "volume rm -f"} {
			if !strings.Contains(j, want) {
				t.Errorf("failure at %q: no cleanup %q in %v", failAt, want, j)
			}
		}
	}
}

func TestSpecValidation(t *testing.T) {
	bad := []func(s *Spec){
		func(s *Spec) { s.RunID = "" },
		func(s *Spec) { s.RunID = "a b" },
		func(s *Spec) { s.RunID = "--privileged" },
		func(s *Spec) { s.Image = "-v /:/host" },
		func(s *Spec) { s.Image = "img --privileged" },
		func(s *Spec) { s.ProxyImage = "" },
		func(s *Spec) { s.CPUs = "" },
		func(s *Spec) { s.Memory = "4g --privileged" },
		func(s *Spec) { s.PIDs = 0 },
		func(s *Spec) { s.AllowHosts = []string{"a.example,b.example"} },
		func(s *Spec) { s.AllowHosts = []string{"https://a.example"} },
		func(s *Spec) { s.AllowHosts = []string{"a.example/path"} },
		func(s *Spec) { s.AllowHosts = []string{""} },
		func(s *Spec) { s.AllowHosts = []string{"a b"} },
	}
	for i, mut := range bad {
		s := spec()
		mut(&s)
		f := &fakeEngine{}
		if _, err := Start(context.Background(), f, s); err == nil {
			t.Errorf("case %d accepted: %+v", i, s)
		}
		if len(f.calls) != 0 {
			t.Errorf("case %d: docker was invoked for an invalid spec", i)
		}
	}
}

func TestExecPassesSecretsByNameOnly(t *testing.T) {
	const secret = "sk-ant-oat01-SECRETSECRETSECRET"
	f := &fakeEngine{}
	s, _ := Start(context.Background(), f, spec())
	_, err := s.Exec(context.Background(), ExecSpec{
		Cmd: []string{"claude", "-p"}, PassEnv: []string{"CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"},
		Env: []string{"CLAUDE_CODE_OAUTH_TOKEN=" + secret}, Stdin: strings.NewReader("prompt"),
	})
	if err != nil {
		t.Fatal(err)
	}
	last := f.calls[len(f.calls)-1]
	if !has(last, "-e", "CLAUDE_CODE_OAUTH_TOKEN") || !has(last, "-e", "ANTHROPIC_API_KEY") || !has(last, "-u", "10001:10001") || !has(last, "-w", "/work") || !has(last, "-i") {
		t.Fatalf("exec args: %v", last)
	}
	for _, c := range f.calls {
		for _, a := range c {
			if strings.Contains(a, secret) || strings.Contains(a, "CLAUDE_CODE_OAUTH_TOKEN=") {
				t.Fatalf("secret value leaked into argv: %v", c)
			}
		}
	}
	if env := f.envs[len(f.envs)-1]; len(env) != 1 || env[0] != "CLAUDE_CODE_OAUTH_TOKEN="+secret {
		t.Fatalf("secret must travel in the CLI environment, got %v", env)
	}
	if _, err := s.Exec(context.Background(), ExecSpec{Cmd: []string{"true"}, PassEnv: []string{"A=B"}}); err == nil {
		t.Fatal("NAME=value accepted as a pass-through name")
	}
	if _, err := s.Exec(context.Background(), ExecSpec{}); err == nil {
		t.Fatal("empty command accepted")
	}
}

func TestCleanOrphans(t *testing.T) {
	f := &fakeEngine{out: map[string]string{
		"ps -a":      "agentfund-dead-sbx 111\nagentfund-live-sbx 222\nagentfund-nopid-sbx",
		"volume ls":  "agentfund-dead-work 111",
		"network ls": "agentfund-dead-net 111\nagentfund-live-net 222",
	}}
	removed, err := CleanOrphans(context.Background(), f, func(pid int) bool { return pid == 222 })
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(removed, ",")
	if got != "agentfund-dead-sbx,agentfund-nopid-sbx,agentfund-dead-work,agentfund-dead-net" {
		t.Fatalf("removed %s", got)
	}
}
