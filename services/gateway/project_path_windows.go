package main

import (
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

func updateUserCLIPath(dir string, add bool) error {
	key, _, err := registry.CreateKey(registry.CURRENT_USER, `Environment`, registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	value, kind, err := key.GetStringValue("Path")
	if err != nil && err != registry.ErrNotExist {
		return err
	}
	parts := []string{}
	found := false
	for _, part := range strings.Split(value, ";") {
		if strings.EqualFold(strings.TrimRight(part, `\/`), strings.TrimRight(dir, `\/`)) {
			found = true
			if !add {
				continue
			}
		}
		if part != "" {
			parts = append(parts, part)
		}
	}
	if add && !found {
		parts = append(parts, dir)
	}
	joined := strings.Join(parts, ";")
	if kind == registry.EXPAND_SZ || kind == 0 {
		err = key.SetExpandStringValue("Path", joined)
	} else {
		err = key.SetStringValue("Path", joined)
	}
	if err != nil {
		return err
	}
	// Notify Explorer so newly opened terminals inherit the updated user PATH.
	environment, _ := windows.UTF16PtrFromString("Environment")
	var result uintptr
	proc := windows.NewLazySystemDLL("user32.dll").NewProc("SendMessageTimeoutW")
	if proc.Find() == nil {
		_, _, _ = proc.Call(0xffff, 0x001a, 0, uintptr(unsafe.Pointer(environment)), 0x0002, 2000, uintptr(unsafe.Pointer(&result)))
	}
	return nil
}
