//go:build !windows

package clash

import (
	"fmt"
	"net/http"
)

func detectedPipe(address string) string { return address }

func namedPipeClient(string) (*http.Client, error) { return nil, fmt.Errorf("Windows only") }
