package main

import (
	"context"
	"fmt"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
	"os"
	"time"
)

type linkosService struct {
	run    func() error
	cancel context.CancelFunc
}

func (s *linkosService) Execute(args []string, requests <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}
	done := make(chan error, 1)
	go func() { done <- s.run() }()
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case e := <-done:
			if e != nil {
				return false, 1
			}
			return false, 0
		case r := <-requests:
			switch r.Cmd {
			case svc.Interrogate:
				status <- r.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending, WaitHint: 30000}
				s.cancel()
			}
		}
	}
}
func runAsService(run func() error, cancel context.CancelFunc) error {
	isService, e := svc.IsWindowsService()
	if e != nil {
		return e
	}
	if isService {
		return svc.Run("LinkOS", &linkosService{run, cancel})
	}
	return run()
}
func runtimeService(action, home, config string) error {
	manager, e := mgr.Connect()
	if e != nil {
		return fmt.Errorf("Windows service manager (run as administrator): %w", e)
	}
	defer manager.Disconnect()
	switch action {
	case "install":
		if s, e := manager.OpenService("LinkOS"); e == nil {
			s.Close()
			return fmt.Errorf("LinkOS service already installed")
		}
		binary, e := os.Executable()
		if e != nil {
			return e
		}
		s, e := manager.CreateService("LinkOS", binary, mgr.Config{DisplayName: "LinkOS workspace", StartType: mgr.StartAutomatic, Description: "Local collaboration workspace"}, "serve", "--home", home, "--config", config)
		if e != nil {
			return e
		}
		defer s.Close()
		if e = s.SetRecoveryActions([]mgr.RecoveryAction{{Type: mgr.ServiceRestart, Delay: 5 * time.Second}}, 86400); e != nil {
			_ = s.Delete()
			return e
		}
		return nil
	case "uninstall":
		s, e := manager.OpenService("LinkOS")
		if e != nil {
			return e
		}
		defer s.Close()
		state, e := s.Query()
		if e != nil {
			return e
		}
		if state.State != svc.Stopped {
			if _, e = s.Control(svc.Stop); e != nil {
				return e
			}
			deadline := time.Now().Add(60 * time.Second)
			for time.Now().Before(deadline) {
				state, e = s.Query()
				if e != nil {
					return e
				}
				if state.State == svc.Stopped {
					break
				}
				time.Sleep(250 * time.Millisecond)
			}
			if state.State != svc.Stopped {
				return fmt.Errorf("service is still draining requests; try again later")
			}
		}
		return s.Delete()
	default:
		return fmt.Errorf("service expects install or uninstall")
	}
}
