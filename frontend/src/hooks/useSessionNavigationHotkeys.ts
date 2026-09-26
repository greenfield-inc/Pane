import { useCallback, useEffect, useMemo } from 'react';
import { useHotkey } from './useHotkey';
import { useCommittedRef } from './useCommittedRef';
import { useHotkeyStore } from '../stores/hotkeyStore';
import { useSessionStore } from '../stores/sessionStore';
import { useNavigationStore } from '../stores/navigationStore';
import { cycleIndex } from '../utils/arrayUtils';
import {
  chooseSidebarCycleSessions,
  createProjectById,
  flattenSessionsByProjects,
  getPinnedSessions,
  groupSessionsByProject,
} from '../utils/sessionOrdering';
import type { Project } from '../types/project';
import type { SwitchSessionId } from '../../../shared/constants/keyboardShortcuts';

interface UseSessionNavigationHotkeysOptions {
  projects: Project[];
  sessionSortAscending: boolean;
}

export function useSessionNavigationHotkeys({
  projects,
  sessionSortAscending,
}: UseSessionNavigationHotkeysOptions): void {
  const sessions = useSessionStore(s => s.sessions);
  const activeSessionId = useSessionStore(s => s.activeSessionId);
  const setActiveSession = useSessionStore(s => s.setActiveSession);
  const navigateToSessions = useNavigationStore(s => s.navigateToSessions);
  const sidebarNavigationScope = useNavigationStore(s => s.sidebarNavigationScope);
  const setSidebarNavigationScope = useNavigationStore(s => s.setSidebarNavigationScope);

  const sessionsByProject = useMemo(
    () => groupSessionsByProject(sessions, sessionSortAscending),
    [sessions, sessionSortAscending]
  );

  const projectById = useMemo(() => createProjectById(projects), [projects]);

  const allActiveSessions = useMemo(() => {
    return flattenSessionsByProjects(projects, sessionsByProject);
  }, [projects, sessionsByProject]);

  const expandedProjects = useNavigationStore(s => s.expandedProjects);
  const registerProjectIds = useNavigationStore(s => s.registerProjectIds);

  // Auto-expand newly added projects. Lives here (not in ProjectSessionList)
  // because this hook stays mounted when the sidebar is collapsed or immersive
  // mode hides it, keeping mod+1-9 numbering alive and consistent.
  useEffect(() => {
    if (projects.length === 0) return;
    const expandedProjectIds = registerProjectIds(projects.map(p => p.id));
    if (expandedProjectIds) {
      void window.electronAPI.uiState.saveExpandedProjects(expandedProjectIds).catch(error => {
        console.error('Failed to save expanded projects:', error);
      });
    }
  }, [projects, registerProjectIds]);

  // Sessions in the exact order ProjectSessionList renders them: projects in
  // display order, collapsed projects skipped, sessions in display order.
  // Pinned rows are excluded, matching the list's hotkey numbering.
  const visibleSessions = useMemo(() => {
    return flattenSessionsByProjects(projects, sessionsByProject, expandedProjects);
  }, [projects, expandedProjects, sessionsByProject]);

  const pinnedSessions = useMemo(() => {
    return getPinnedSessions(sessions, projectById).map(item => item.session);
  }, [sessions, projectById]);

  const allActiveSessionsRef = useCommittedRef(allActiveSessions);
  const visibleSessionsRef = useCommittedRef(visibleSessions);
  const pinnedSessionsRef = useCommittedRef(pinnedSessions);
  const activeSessionIdRef = useCommittedRef(activeSessionId);
  const sidebarNavigationScopeRef = useCommittedRef(sidebarNavigationScope);
  const setActiveSessionRef = useCommittedRef(setActiveSession);
  const setSidebarNavigationScopeRef = useCommittedRef(setSidebarNavigationScope);
  const navigateToSessionsRef = useCommittedRef(navigateToSessions);

  const cycleSession = useCallback((direction: 'next' | 'prev') => {
    const sessions = allActiveSessionsRef.current;
    if (sessions.length === 0) return;

    const currentId = activeSessionIdRef.current;
    const currentIndex = sessions.findIndex(s => s.id === currentId);
    const nextIndex = cycleIndex(currentIndex, sessions.length, direction);
    if (nextIndex === -1) return;

    setActiveSessionRef.current(sessions[nextIndex].id);
    navigateToSessionsRef.current();
  }, [activeSessionIdRef, allActiveSessionsRef, navigateToSessionsRef, setActiveSessionRef]);

  const cycleVisibleOrAllSessions = useCallback((direction: 'next' | 'prev') => {
    const currentId = activeSessionIdRef.current;
    const sessions = chooseSidebarCycleSessions(
      sidebarNavigationScopeRef.current,
      currentId,
      pinnedSessionsRef.current,
      visibleSessionsRef.current,
      allActiveSessionsRef.current
    );
    if (sessions.length === 0) return;

    const currentIndex = sessions.findIndex(s => s.id === currentId);
    const nextIndex = cycleIndex(currentIndex, sessions.length, direction);
    if (nextIndex === -1) return;

    setActiveSessionRef.current(sessions[nextIndex].id);
    navigateToSessionsRef.current();
  }, [
    activeSessionIdRef,
    allActiveSessionsRef,
    navigateToSessionsRef,
    pinnedSessionsRef,
    setActiveSessionRef,
    sidebarNavigationScopeRef,
    visibleSessionsRef,
  ]);

  useHotkey({
    id: 'cycle-session-next-0',
    label: 'Next Pane',
    category: 'session',
    enabled: () => allActiveSessionsRef.current.length > 1,
    action: () => cycleSession('next'),
  });

  useHotkey({
    id: 'cycle-session-prev-0',
    label: 'Previous Pane',
    category: 'session',
    enabled: () => allActiveSessionsRef.current.length > 1,
    action: () => cycleSession('prev'),
  });

  useHotkey({
    id: 'cycle-sidebar-session-next',
    label: 'Next Pane in Sidebar',
    category: 'session',
    enabled: () => {
      const sessions = chooseSidebarCycleSessions(
        sidebarNavigationScopeRef.current,
        activeSessionIdRef.current,
        pinnedSessionsRef.current,
        visibleSessionsRef.current,
        allActiveSessionsRef.current
      );
      return sessions.length > 1;
    },
    action: () => cycleVisibleOrAllSessions('next'),
  });

  useHotkey({
    id: 'cycle-sidebar-session-prev',
    label: 'Previous Pane in Sidebar',
    category: 'session',
    enabled: () => {
      const sessions = chooseSidebarCycleSessions(
        sidebarNavigationScopeRef.current,
        activeSessionIdRef.current,
        pinnedSessionsRef.current,
        visibleSessionsRef.current,
        allActiveSessionsRef.current
      );
      return sessions.length > 1;
    },
    action: () => cycleVisibleOrAllSessions('prev'),
  });

  const projectByIdRef = useCommittedRef(projectById);

  const register = useHotkeyStore(s => s.register);
  const unregister = useHotkeyStore(s => s.unregister);

  // Register mod+1-9 with dynamic session name labels. Build a stable label key
  // so we re-register when session names/projects change.
  const sessionLabelKey = visibleSessions.slice(0, 9).map(s => `${s.name}:${s.projectId}`).join('|');

  useEffect(() => {
    const ids: SwitchSessionId[] = [];
    for (let i = 1; i <= 9; i++) {
      // SAFETY: The loop is explicitly bounded to the catalog's 1..9 session slots.
      const id = `switch-session-${i}` as SwitchSessionId;
      ids.push(id);
      const session = visibleSessionsRef.current[i - 1];
      let label = `Switch to pane ${i}`;
      if (session) {
        const project = session.projectId != null ? projectByIdRef.current.get(session.projectId) : undefined;
        label = project
          ? `Switch to ${session.name} (${project.name})`
          : `Switch to ${session.name}`;
      }
      const idx = i - 1;
      register({
        id,
        label,
        category: 'session',
        enabled: () => !!visibleSessionsRef.current[idx],
        action: () => {
          const s = visibleSessionsRef.current[idx];
          if (s) {
            setSidebarNavigationScopeRef.current('repositories');
            setActiveSessionRef.current(s.id);
            navigateToSessionsRef.current();
          }
        },
      });
    }
    return () => ids.forEach(id => unregister(id));
  }, [
    navigateToSessionsRef,
    projectByIdRef,
    register,
    sessionLabelKey,
    setActiveSessionRef,
    setSidebarNavigationScopeRef,
    unregister,
    visibleSessionsRef,
  ]);
}
