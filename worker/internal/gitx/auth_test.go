package gitx

import (
	"context"
	"strings"
	"testing"
)

func TestAuthConfig(t *testing.T) {
	if cfg, err := authConfig("https://github.com/acme/internal", AuthNone); err != nil || cfg != nil {
		t.Fatalf("none: %v %v", cfg, err)
	}
	cfg, err := authConfig("https://github.com/acme/internal", AuthGH)
	if err != nil {
		t.Fatal(err)
	}
	j := strings.Join(cfg, " ")
	for _, want := range []string{"credential.https://github.com.helper=!gh auth git-credential", "http.followRedirects=false"} {
		if !strings.Contains(j, want) {
			t.Errorf("gh auth config lacks %q: %s", want, j)
		}
	}
	// The donor's gh credentials never go anywhere but github.com over https.
	for _, bad := range []string{"https://gitlab.com/a/b", "https://github.com.evil.example/a/b", "https://github.com:8443/a/b", "file:///tmp/x", "http://github.com/a/b"} {
		if _, err := authConfig(bad, AuthGH); err == nil {
			t.Errorf("gh auth accepted for %q", bad)
		}
	}
	if _, err := authConfig("https://github.com/a/b", Auth("token")); err == nil {
		t.Error("unknown auth accepted")
	}
	if err := FetchAuth(context.Background(), t.TempDir(), "https://gitlab.com/a/b", AuthGH); err == nil {
		t.Error("FetchAuth with gh for a non-GitHub host")
	}
}
