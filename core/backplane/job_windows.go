//go:build windows

package backplane

import (
	"golang.org/x/sys/windows"
	"unsafe"
)

func AttachJob(pid int) (func(), error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | windows.JOB_OBJECT_LIMIT_PROCESS_MEMORY | windows.JOB_OBJECT_LIMIT_ACTIVE_PROCESS
	info.ProcessMemoryLimit = 256 * 1024 * 1024
	info.BasicLimitInformation.ActiveProcessLimit = 1
	if _, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	proc, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	defer windows.CloseHandle(proc)
	if err = windows.AssignProcessToJobObject(job, proc); err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	return func() { windows.CloseHandle(job) }, nil
}
func LockSession() error {
	r, _, err := windows.NewLazySystemDLL("user32.dll").NewProc("LockWorkStation").Call()
	if r == 0 {
		return err
	}
	return nil
}
