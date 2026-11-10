// Command agentfund is the AgentFund worker and maintainer CLI.
package main

import (
	"os"

	"github.com/ghvstcode/agentfund/worker/internal/cli"
)

func main() { os.Exit(cli.Main(os.Args[1:], os.Stdin, os.Stdout, os.Stderr)) }
