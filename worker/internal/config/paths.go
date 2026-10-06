// Package config loads and saves the donor's configuration, approvals and
// server credentials.
package config

import (
	"os"
	"path/filepath"

	"github.com/agentfund/agentfund/worker/internal/app"
)

// Environment variables that relocate state (useful for tests and e2e).
const (
	EnvConfigDir = app.EnvPrefix + "_CONFIG_DIR"
	EnvDataDir   = app.EnvPrefix + "_DATA_DIR"
	EnvAPIKey    = app.EnvPrefix + "_API_KEY"
	EnvKeyPass   = app.EnvPrefix + "_KEY_PASSWORD"
	EnvKey       = app.EnvPrefix + "_KEY"
)

func home() string {
	if h, err := os.UserHomeDir(); err == nil {
		return h
	}
	return "."
}

// Dir returns the configuration directory:
// $AGENTFUND_CONFIG_DIR, else $XDG_CONFIG_HOME/agentfund, else ~/.config/agentfund.
func Dir() string {
	if d := os.Getenv(EnvConfigDir); d != "" {
		return d
	}
	if d := os.Getenv("XDG_CONFIG_HOME"); d != "" {
		return filepath.Join(d, app.BinaryName)
	}
	return filepath.Join(home(), ".config", app.BinaryName)
}

// DataDir returns the state directory:
// $AGENTFUND_DATA_DIR, else $XDG_DATA_HOME/agentfund, else ~/.local/share/agentfund.
func DataDir() string {
	if d := os.Getenv(EnvDataDir); d != "" {
		return d
	}
	if d := os.Getenv("XDG_DATA_HOME"); d != "" {
		return filepath.Join(d, app.BinaryName)
	}
	return filepath.Join(home(), ".local", "share", app.BinaryName)
}

// File locations.
func Path() string            { return filepath.Join(Dir(), "config.yaml") }
func CredentialsPath() string { return filepath.Join(Dir(), "credentials.yaml") }
func KeysDir() string         { return filepath.Join(Dir(), "keys") }
func ReposDir() string        { return filepath.Join(DataDir(), "repos") }
func LogsDir() string         { return filepath.Join(DataDir(), "logs") }
func StorePath() string       { return filepath.Join(DataDir(), "state.json") }
func WorkDir() string         { return filepath.Join(DataDir(), "work") }
