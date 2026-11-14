// Command mock-agent is a test stand-in for the coding-agent CLI. It is
// installed as `claude` in the test-only sandbox image
// (images/sandbox/Dockerfile.e2e), accepts the flags the worker passes to the
// real CLI, reads the prompt from stdin, emits the same stream-json event
// shapes, and performs a deterministic, scripted behaviour.
//
// The behaviour is selected by MOCK_AGENT_SCENARIO, which the *test image*
// sets — there is no switch for it anywhere in the worker.
//
//	happy       write an in-scope implementation + test that makes verify pass (slugify, or
//	            truncate when the prompt is hello-project's second task)
//	scope       like happy, plus a file outside scope.write
//	verifyfail  write an in-scope implementation whose test fails
//	budget      burn tokens slowly, without end, until killed
//	hang        emit the init event, then do nothing forever
//	ratelimit   emit a rate-limit refusal and exit non-zero
//	autherror   emit an authentication failure and exit non-zero
//	unreachable never reach the model API: connection retries, then an error result
//	            without an HTTP status (the shape Claude Code 2.1.289 emits with no route)
//	leak        like happy, but write the credential it was given into an in-scope file
//	nochange    succeed without touching any file
//
// Every scenario echoes the credential environment variables it received
// into its stream and stderr, so tests can prove the worker scrubs them.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Flags of the real CLI the worker may pass. Value-taking flags map to true.
var knownFlags = map[string]bool{
	"-p": false, "--print": false, "--verbose": false, "--include-partial-messages": false,
	"--dangerously-skip-permissions": false, "--strict-mcp-config": false, "--no-session-persistence": false,
	"--output-format": true, "--setting-sources": true, "--model": true, "--permission-mode": true,
	"--tools": true,
}

const version = "0.0.0-mock"

func emit(v any) {
	b, _ := json.Marshal(v)
	fmt.Println(string(b))
}

type usage struct {
	In, CacheCreate, CacheRead, Out int
}

var (
	total   usage
	calls   int
	session = "00000000-0000-4000-8000-000000000001"
	model   = "mock-model-1"
)

// call emits one model call the way the real CLI does: message_start, an
// assistant message carrying the same id with a placeholder output count,
// then message_delta with the real output count.
func call(u usage, text string) {
	calls++
	total.In += u.In
	total.CacheCreate += u.CacheCreate
	total.CacheRead += u.CacheRead
	total.Out += u.Out
	id := fmt.Sprintf("msg_mock_%03d", calls)
	in := map[string]any{"input_tokens": u.In, "cache_creation_input_tokens": u.CacheCreate, "cache_read_input_tokens": u.CacheRead, "output_tokens": 1}
	emit(map[string]any{"type": "stream_event", "session_id": session, "parent_tool_use_id": nil,
		"event": map[string]any{"type": "message_start", "message": map[string]any{"id": id, "model": model, "role": "assistant", "usage": in}}})
	emit(map[string]any{"type": "assistant", "session_id": session, "parent_tool_use_id": nil,
		"message": map[string]any{"id": id, "model": model, "role": "assistant", "content": []any{map[string]any{"type": "text", "text": text}}, "usage": in}})
	emit(map[string]any{"type": "stream_event", "session_id": session, "parent_tool_use_id": nil,
		"event": map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "end_turn"},
			"usage": map[string]any{"input_tokens": u.In, "cache_creation_input_tokens": u.CacheCreate, "cache_read_input_tokens": u.CacheRead, "output_tokens": u.Out}}})
}

func result(isError bool, subtype, text string, apiStatus any) {
	emit(map[string]any{
		"type": "result", "subtype": subtype, "is_error": isError, "result": text, "session_id": session, "num_turns": calls,
		"total_cost_usd": 0.0123, "api_error_status": apiStatus,
		"usage":      map[string]any{"input_tokens": total.In, "cache_creation_input_tokens": total.CacheCreate, "cache_read_input_tokens": total.CacheRead, "output_tokens": total.Out},
		"modelUsage": map[string]any{model: map[string]any{"inputTokens": total.In, "outputTokens": total.Out, "cacheReadInputTokens": total.CacheRead, "cacheCreationInputTokens": total.CacheCreate, "costUSD": 0.0123}},
	})
}

func write(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(content), 0o644)
}

const goodImpl = `import re


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug or "untitled"
`

const goodTest = `import unittest

from src.textutil import slugify


class SlugifyTest(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(slugify("Hello, World!"), "hello-world")

    def test_empty(self):
        self.assertEqual(slugify("!!!"), "untitled")


if __name__ == "__main__":
    unittest.main()
`

const truncateImpl = `

def truncate(text: str, width: int) -> str:
    if width < 1:
        raise ValueError("width must be >= 1")
    if len(text) <= width:
        return text
    return text[: width - 1] + "\u2026"
`

const truncateTest = `import unittest

from src.textutil import truncate


class TruncateTest(unittest.TestCase):
    def test_short(self):
        self.assertEqual(truncate("abc", 5), "abc")

    def test_long(self):
        self.assertEqual(truncate("Hello, World", 5), "Hell\u2026")

    def test_invalid(self):
        with self.assertRaises(ValueError):
            truncate("abc", 0)


if __name__ == "__main__":
    unittest.main()
`

const badImpl = `def slugify(text: str) -> str:
    return text
`

func main() {
	args := os.Args[1:]
	var outputFormat string
	tools := []string{"Task", "Bash", "Edit", "Read", "Write", "WebSearch", "RemoteTrigger"} // like the real default: more than a task needs
	printMode, verbose, skipPerms := false, false, false
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--version" || a == "-v" {
			fmt.Printf("%s (mock agent)\n", version)
			return
		}
		takesValue, ok := knownFlags[a]
		if !ok {
			fmt.Fprintf(os.Stderr, "error: unknown option '%s'\n", a)
			os.Exit(2)
		}
		val := ""
		if takesValue {
			if i+1 >= len(args) {
				fmt.Fprintf(os.Stderr, "error: option '%s' argument missing\n", a)
				os.Exit(2)
			}
			i++
			val = args[i]
		}
		switch a {
		case "-p", "--print":
			printMode = true
		case "--verbose":
			verbose = true
		case "--dangerously-skip-permissions":
			skipPerms = true
		case "--output-format":
			outputFormat = val
		case "--model":
			model = val
		case "--tools":
			tools = strings.Split(val, ",")
		}
	}
	if !printMode || outputFormat != "stream-json" || !verbose {
		fmt.Fprintln(os.Stderr, "error: the mock agent supports only -p --output-format stream-json --verbose")
		os.Exit(2)
	}
	if skipPerms && os.Getuid() == 0 {
		fmt.Fprintln(os.Stderr, "--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons")
		os.Exit(1)
	}
	promptBytes, _ := io.ReadAll(os.Stdin)
	prompt := string(promptBytes)
	if strings.TrimSpace(prompt) == "" {
		fmt.Fprintln(os.Stderr, "error: no prompt on stdin")
		os.Exit(1)
	}

	cwd, _ := os.Getwd()
	token, apiKey := os.Getenv("CLAUDE_CODE_OAUTH_TOKEN"), os.Getenv("ANTHROPIC_API_KEY")
	scenario := os.Getenv("MOCK_AGENT_SCENARIO")
	if scenario == "" {
		scenario = "happy"
	}
	_, gitErr := os.Stat(".git")
	emit(map[string]any{
		"type": "system", "subtype": "init", "session_id": session, "model": model, "claude_code_version": version,
		"cwd": cwd, "permissionMode": "bypassPermissions", "tools": tools,
		"mock": map[string]any{
			"scenario": scenario, "uid": os.Getuid(), "prompt_bytes": len(prompt), "prompt_head": firstLine(prompt),
			"has_oauth_token": token != "", "has_api_key": apiKey != "", "https_proxy": os.Getenv("HTTPS_PROXY"),
			"ssl_cert_file": os.Getenv("SSL_CERT_FILE"), "node_extra_ca_certs": os.Getenv("NODE_EXTRA_CA_CERTS"),
			"has_git_dir": gitErr == nil, "args": args,
		},
	})
	// Echo what a careless (or hostile) agent might echo: the credentials.
	fmt.Fprintf(os.Stderr, "mock-agent debug: CLAUDE_CODE_OAUTH_TOKEN=%s ANTHROPIC_API_KEY=%s\n", token, apiKey)
	leak := fmt.Sprintf("starting (debug: token=%s key=%s)", token, apiKey)

	fail := func(err error) {
		call(usage{In: 100, Out: 10}, "cannot write: "+err.Error())
		result(true, "error_during_execution", err.Error(), nil)
		os.Exit(1)
	}

	if scenario == "happy" && strings.Contains(prompt, "truncate(text: str, width: int)") {
		scenario = "happy-truncate"
	}
	switch scenario {
	case "happy-truncate":
		// Second hello-project task: extend the existing module, add its own test file.
		call(usage{In: 1300, CacheRead: 900, Out: 60}, leak)
		existing, _ := os.ReadFile("src/textutil.py")
		if err := write("src/textutil.py", string(existing)+truncateImpl); err != nil {
			fail(err)
		}
		if err := write("tests/test_truncate.py", truncateTest); err != nil {
			fail(err)
		}
		call(usage{In: 1400, CacheRead: 2200, Out: 40}, "added truncate")
		result(false, "success", "Implemented truncate with tests.", nil)
	case "happy", "scope", "leak":
		call(usage{In: 1000, CacheCreate: 200, CacheRead: 300, Out: 50}, leak)
		impl := goodImpl
		if scenario == "leak" {
			impl += "\nTOKEN = \"" + token + apiKey + "\"\n"
		}
		if err := write("src/textutil.py", impl); err != nil {
			fail(err)
		}
		call(usage{In: 1100, CacheRead: 1500, Out: 70}, "wrote src/textutil.py")
		if err := write("tests/test_slugify.py", goodTest); err != nil {
			fail(err)
		}
		if scenario == "scope" {
			// src/ is writable for new files (sticky), but this path is not in scope.write.
			if err := write("src/backdoor.py", "print('not in scope')\n"); err != nil {
				fail(err)
			}
		}
		call(usage{In: 1200, CacheRead: 2800, Out: 30}, "wrote tests/test_slugify.py")
		result(false, "success", "Implemented slugify with tests.", nil)
	case "verifyfail":
		call(usage{In: 900, Out: 40}, leak)
		if err := write("src/textutil.py", badImpl); err != nil {
			fail(err)
		}
		if err := write("tests/test_slugify.py", goodTest); err != nil {
			fail(err)
		}
		call(usage{In: 950, Out: 20}, "done (but wrong)")
		result(false, "success", "Done.", nil)
	case "nochange":
		call(usage{In: 500, Out: 20}, leak)
		result(false, "success", "Nothing to do.", nil)
	case "budget":
		call(usage{In: 1000, Out: 10}, leak)
		for {
			time.Sleep(200 * time.Millisecond)
			call(usage{In: 90_000, CacheRead: 10_000, Out: 5_000}, "still thinking…")
		}
	case "hang":
		call(usage{In: 700, Out: 7}, leak)
		for {
			time.Sleep(time.Hour)
		}
	case "ratelimit":
		call(usage{In: 400, Out: 4}, leak)
		emit(map[string]any{"type": "rate_limit_event", "session_id": session,
			"rate_limit_info": map[string]any{"status": "rejected", "resetsAt": time.Now().Add(90 * time.Minute).Unix(), "rateLimitType": "five_hour"}})
		emit(map[string]any{"type": "assistant", "session_id": session, "parent_tool_use_id": nil, "error": "rate_limit",
			"message": map[string]any{"id": "msg_mock_err", "model": model, "role": "assistant", "content": []any{map[string]any{"type": "text", "text": "usage limit reached"}}}})
		result(true, "success", "Claude usage limit reached.", 429)
		os.Exit(1)
	case "autherror":
		emit(map[string]any{"type": "assistant", "session_id": session, "parent_tool_use_id": nil, "error": "authentication_failed",
			"message": map[string]any{"id": "msg_mock_err", "model": model, "role": "assistant", "content": []any{map[string]any{"type": "text", "text": "Invalid API key"}}}})
		result(true, "success", "Invalid API key · Please run /login", 401)
		os.Exit(1)
	case "unreachable":
		const msg = "API Error: Couldn't connect through your proxy (ERR_PROXY_TUNNEL) — the proxy refused the tunnel: check its credentials and that it allows this host"
		for i := 1; i <= 3; i++ {
			emit(map[string]any{"type": "system", "subtype": "api_retry", "attempt": i, "max_retries": 10, "retry_delay_ms": 500,
				"error_status": nil, "error": "unknown", "session_id": session})
		}
		emit(map[string]any{"type": "assistant", "session_id": session, "parent_tool_use_id": nil, "error": "server_error", "is_api_error_message": true,
			"message": map[string]any{"id": "00000000-0000-4000-8000-000000000002", "model": "<synthetic>", "role": "assistant",
				"usage":   map[string]any{"input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
				"content": []any{map[string]any{"type": "text", "text": msg}}}})
		emit(map[string]any{"type": "result", "subtype": "success", "is_error": true, "result": msg, "session_id": session, "num_turns": 1,
			"total_cost_usd": 0, "api_error_status": nil, "terminal_reason": "api_error",
			"usage":      map[string]any{"input_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 0},
			"modelUsage": map[string]any{}})
		os.Exit(1)
	default:
		fmt.Fprintf(os.Stderr, "mock-agent: unknown MOCK_AGENT_SCENARIO %q\n", scenario)
		os.Exit(2)
	}
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 120 {
		s = s[:120]
	}
	return s
}
