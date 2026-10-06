//go:build !windows

package netease

import "context"

type unsupportedMedia struct{}

func NewMedia(context.Context) Media { return unsupportedMedia{} }
func (unsupportedMedia) Close()      {}
func (unsupportedMedia) Call(context.Context, Action) (Reading, error) {
	return Reading{}, fail("unavailable", "网易云音乐适配需要 Windows Core")
}
