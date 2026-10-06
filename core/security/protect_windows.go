//go:build windows

package security

import (
	"golang.org/x/sys/windows"
	"unsafe"
)

func Protect(data []byte) ([]byte, error)   { return dpapi(data, true) }
func Unprotect(data []byte) ([]byte, error) { return dpapi(data, false) }
func dpapi(data []byte, protect bool) ([]byte, error) {
	in := windows.DataBlob{Size: uint32(len(data))}
	if len(data) > 0 {
		in.Data = &data[0]
	}
	var out windows.DataBlob
	var err error
	if protect {
		err = windows.CryptProtectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out)
	} else {
		err = windows.CryptUnprotectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out)
	}
	if err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return append([]byte(nil), unsafe.Slice(out.Data, out.Size)...), nil
}
