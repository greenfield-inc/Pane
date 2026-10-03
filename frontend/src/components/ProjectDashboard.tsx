import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { RefreshCw, GitBranch, AlertCircle, CheckCircle, GitPullRequest, Loader2, XCircle, Filter } from 'lucide-react';
import { API } from '../utils/api';
import type { ProjectDashboardData, SessionBranchInfo } from '../types/projectDashboard';
import { formatDistanceToNow } from '../utils/timestampUtils';
import { dashboardCache } from '../utils/dashboardCache';
import { debounce } from '../utils/debounce';
import { ProjectDashboardSkeleton } from './ProjectDashboardSkeleton';
import { useSessionStore } from '../stores/sessionStore';
import { useNavigationStore } from '../stores/navigationStore';
import { MultiOriginStatus } from './dashboard/MultiOriginStatus';
import { StatusSummaryCards } from './dashboard/StatusSummaryCards';
import { Card } from './ui/Card';
import { Button } from './ui/Button';
import { LiveRegion } from './ui/LiveRegion';

interface ProjectDashboardProps {
  projectId: number;
  projectName: string;
}

function isProjectDashboardSeed(data: Partial<ProjectDashboardData>): data is ProjectDashboardData {
  return data.projectId !== undefined
    && Boolean(data.projectName)
    && Boolean(data.projectPath)
    && Boolean(data.mainBranch)
    && Array.isArray(data.sessionBranches)
    && Boolean(data.lastRefreshed);
}

export const ProjectDashboard: React.FC<ProjectDashboardProps> = React.memo(({ projectId, projectName }) => {
  const [dashboardData, setDashboardData] = useState<ProjectDashboardData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshTime, setLastRefreshTime] = useState<Date | null>(null);
  const [filterType, setFilterType] = useState<'all' | 'stale' | 'changes' | 'pr'>('all');
  const handleFilterTypeChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    // SAFETY: The select options enumerate every valid dashboard filter.
    setFilterType(event.target.value as typeof filterType);
  };
  const [statusAnnouncement, setStatusAnnouncement] = useState('');
  const requests = useRef({ id: 0 }).current;
  const pendingSessionUpdatesRef = useRef<Map<string, SessionBranchInfo>>(new Map());
  const dashboardDataRef = useRef<ProjectDashboardData | null>(null);

  useEffect(() => {
    dashboardDataRef.current = dashboardData;
  }, [dashboardData]);

  // Debounced function to apply pending session updates
  const applyPendingSessionUpdates = useMemo(
    () => debounce(() => {
      const updates = Array.from(pendingSessionUpdatesRef.current.values());
      if (updates.length === 0) return;

      setDashboardData(prevData => {
        if (!prevData) return null;
        
        const sessionMap = new Map(
          prevData.sessionBranches.map(s => [s.sessionId, s])
        );
        
        // Apply all pending updates
        updates.forEach(update => {
          sessionMap.set(update.sessionId, update);
        });
        
        // Clear pending updates
        pendingSessionUpdatesRef.current.clear();
        
        return {
          ...prevData,
          sessionBranches: Array.from(sessionMap.values())
        };
      });
    }, 100), // 100ms debounce for smooth updates
    []
  );

  const fetchDashboardData = useCallback(async (useCache: boolean = true) => {
    const requestId = ++requests.id;
    // Check cache first if not forcing refresh
    if (useCache) {
      const cachedData = dashboardCache.get(projectId);
      if (cachedData) {
        setIsLoading(false);
        setIsRefreshing(false);
        setError(null);
        setDashboardData(cachedData);
        setLastRefreshTime(new Date(Date.now() - 30000)); // Show it was from cache
        setStatusAnnouncement('Dashboard loaded from cache');
        return;
      }
    }
    
    const hasDashboardData = dashboardDataRef.current !== null;
    setIsLoading(!hasDashboardData); // Only show loading on initial load
    setIsRefreshing(hasDashboardData); // Show refreshing if we already have data
    setError(null);
    setStatusAnnouncement(hasDashboardData ? 'Refreshing dashboard' : 'Loading dashboard');
    
    try {
      const response = await API.dashboard.getProjectStatusProgressive(projectId);
      if (requestId !== requests.id) return;
      if (response.success && response.data) {
        applyPendingSessionUpdates.cancel();
        pendingSessionUpdatesRef.current.clear();
        setDashboardData(response.data);
        setLastRefreshTime(new Date());
        dashboardCache.set(projectId, response.data);
        setStatusAnnouncement('Dashboard updated');
      } else {
        setError(response.error || 'Failed to fetch project status');
      }
    } catch (err) {
      if (requestId === requests.id) setError(err instanceof Error ? err.message : 'Unknown error occurred');
    } finally {
      if (requestId === requests.id) {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    }
  }, [projectId, applyPendingSessionUpdates, requests]);

  // Debounced refresh function
  const debouncedRefresh = useMemo(
    () => debounce(() => {
      dashboardCache.invalidate(projectId);
      fetchDashboardData(false);
    }, 500),
    [projectId, fetchDashboardData]
  );

  // Set up progressive loading event listeners
  useEffect(() => {
    const cleanupFns: Array<() => void> = [];
    const pendingUpdates = pendingSessionUpdatesRef.current;

    // Handle dashboard updates
    const unsubscribeUpdate = API.dashboard.onUpdate((event) => {
      if (event.projectId === projectId) {
        if (!event.isPartial) {
          applyPendingSessionUpdates.cancel();
          pendingSessionUpdatesRef.current.clear();
        }
        setDashboardData(prevData => {
          if (!prevData) {
            return isProjectDashboardSeed(event.data) ? event.data : null;
          } else if (prevData && event.isPartial) {
            // Merge partial update
            return {
              ...prevData,
              ...event.data,
              sessionBranches: event.data.sessionBranches?.length ? event.data.sessionBranches : prevData.sessionBranches,
            };
          } else if (!event.isPartial) {
            // Full update
            const data = event.data;
            if (data.projectId && data.projectName && data.sessionBranches) {
              dashboardCache.set(projectId, data);
            }
            return data;
          }
          return prevData;
        });
        
        if (!event.isPartial) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    });
    cleanupFns.push(unsubscribeUpdate);

    // Handle individual session updates with debouncing
    const unsubscribeSession = API.dashboard.onSessionUpdate((event) => {
      if (event.projectId === projectId) {
        // Add to pending updates
        pendingSessionUpdatesRef.current.set(event.session.sessionId, event.session);
        // Trigger debounced update
        applyPendingSessionUpdates();
      }
    });
    cleanupFns.push(unsubscribeSession);

    return () => {
      cleanupFns.forEach(fn => fn());
      // Cancel any pending updates
      applyPendingSessionUpdates.cancel();
      pendingUpdates.clear();
    };
  }, [projectId, applyPendingSessionUpdates]);

  useEffect(() => {
    // Clear previous data when switching projects to show skeleton
    dashboardDataRef.current = null;
    setDashboardData(null);
    setError(null);
    void fetchDashboardData();
    return () => {
      requests.id++;
      debouncedRefresh.cancel();
    };
  }, [fetchDashboardData, debouncedRefresh, requests]);

  const renderSessionRow = useCallback((session: SessionBranchInfo) => {
    const staleClass = session.isStale ? 'bg-status-warning/10' : '';
    
    const handleSessionClick = async () => {
      try {
        await useSessionStore.getState().setActiveSession(session.sessionId);
        useNavigationStore.getState().navigateToSessions();
      } catch (error) {
        console.error('[ProjectDashboard] Error in handleSessionClick:', error);
      }
    };
    
    return (
      <tr key={session.sessionId} className={`hover:bg-surface-hover ${staleClass}`}>
        <td className="px-4 py-3 text-sm">
          <button type="button" className="flex w-full items-center gap-2 text-left" onClick={handleSessionClick}>
            <GitBranch className="w-4 h-4 text-text-tertiary" />
            <div>
              <div className="font-medium text-text-primary">{session.sessionName}</div>
              <div className="text-text-tertiary text-xs">{session.branchName}</div>
            </div>
          </button>
        </td>
        <td className="px-4 py-3 text-sm text-text-secondary">
          <code className="text-xs bg-surface-secondary px-1 py-0.5 rounded">
            {session.baseBranch}
          </code>
        </td>
        <td className="px-4 py-3 text-sm">
          {session.isStale ? (
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-status-warning" />
              <span className="text-status-warning">
                Stale {session.staleSince && `since ${formatDistanceToNow(session.staleSince)}`}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-status-success" />
              <span className="text-status-success">Current</span>
            </div>
          )}
        </td>
        <td className="px-4 py-3 text-sm text-text-secondary">
          <div className="flex gap-3 text-xs">
            {session.commitsAhead > 0 && (
              <span className="text-interactive">+{session.commitsAhead}</span>
            )}
            {session.commitsBehind > 0 && (
              <span className="text-status-warning">-{session.commitsBehind}</span>
            )}
            {session.commitsAhead === 0 && session.commitsBehind === 0 && (
              <span className="text-text-tertiary">—</span>
            )}
          </div>
        </td>
        <td className="px-4 py-3 text-sm">
          {session.hasUncommittedChanges && (
            <span className="inline-flex items-center gap-1 text-status-warning">
              <AlertCircle className="w-3 h-3" />
              <span className="text-xs">Uncommitted</span>
            </span>
          )}
        </td>
        <td className="px-4 py-3 text-sm">
          {session.pullRequest ? (
            <a
              href={session.pullRequest.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-interactive hover:text-interactive-hover"
            >
              <GitPullRequest className="w-4 h-4" />
              <span>#{session.pullRequest.number}</span>
              {session.pullRequest.state === 'open' && (
                <span className="inline-block w-2 h-2 bg-status-success rounded-full"></span>
              )}
              {session.pullRequest.state === 'closed' && (
                <XCircle className="w-3 h-3 text-status-error" />
              )}
              {session.pullRequest.state === 'merged' && (
                <CheckCircle className="w-3 h-3 text-interactive" />
              )}
            </a>
          ) : (
            <span className="text-text-tertiary">—</span>
          )}
        </td>
      </tr>
    );
  }, []);

  // Filter sessions based on selected filter
  const filteredSessions = useMemo(() => {
    if (!dashboardData) return [];
    
    switch (filterType) {
      case 'stale':
        return dashboardData.sessionBranches.filter(s => s.isStale);
      case 'changes':
        return dashboardData.sessionBranches.filter(s => s.hasUncommittedChanges);
      case 'pr':
        return dashboardData.sessionBranches.filter(s => s.pullRequest);
      default:
        return dashboardData.sessionBranches;
    }
  }, [dashboardData, filterType]);

  if (error) {
    return (
      <div role="alert" className="p-6 bg-status-error/10 rounded-lg">
        <div className="flex items-center gap-2 text-status-error">
          <AlertCircle className="w-5 h-5" />
          <span className="font-medium">Error loading dashboard</span>
        </div>
        <p className="mt-1 text-sm text-status-error/80">{error}</p>
        <button
          type="button"
          onClick={() => fetchDashboardData(false)}
          className="mt-3 px-3 py-1 text-sm bg-status-error text-text-on-status-error rounded hover:bg-status-error-hover"
        >
          Try Again
        </button>
      </div>
    );
  }

  if (isLoading && !dashboardData) {
    return <div><LiveRegion>{statusAnnouncement}</LiveRegion><ProjectDashboardSkeleton /></div>;
  }

  return (
    <Card className="flex flex-col h-full">
      <LiveRegion>{statusAnnouncement}</LiveRegion>
      <div className="px-6 py-4 border-b border-border-primary">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">
              Project Dashboard
            </h2>
            <p className="text-sm text-text-secondary">
              Git status for {dashboardData?.projectName || projectName}
            </p>
          </div>
          <div className="flex items-center gap-4">
            {lastRefreshTime && (
              <span className="text-xs text-text-tertiary">
                Updated {formatDistanceToNow(lastRefreshTime)}
              </span>
            )}
            <Button
              onClick={debouncedRefresh}
              disabled={isLoading || isRefreshing}
              variant="secondary"
              size="sm"
              icon={(isLoading || isRefreshing) ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            >
              Refresh
            </Button>
          </div>
        </div>
      </div>

      {dashboardData ? (
        <div className="p-6 flex-1 flex flex-col overflow-hidden">
          {/* Multi-Origin Status */}
          {dashboardData.mainBranchStatus && (
            <MultiOriginStatus 
              mainBranch={dashboardData.mainBranch}
              mainBranchStatus={dashboardData.mainBranchStatus}
              remotes={dashboardData.remotes}
            />
          )}
          
          {/* Status Summary Cards */}
          <StatusSummaryCards sessions={dashboardData.sessionBranches} />

          {/* Session Branches Table */}
          {dashboardData.sessionBranches.length > 0 ? (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-text-primary">
                  Pane Branches ({filteredSessions.length} of {dashboardData.sessionBranches.length})
                </h3>
                <div className="flex items-center gap-2">
                  <Filter className="w-4 h-4 text-text-tertiary" />
                  <select
                    value={filterType}
                    onChange={handleFilterTypeChange}
                    className="text-sm border border-border-primary rounded px-2 py-1 bg-surface-primary text-text-primary focus:outline-none focus:ring-2 focus:ring-interactive focus:border-interactive"
                  >
                    <option value="all">All Panes</option>
                    <option value="stale">Stale Only</option>
                    <option value="changes">With Changes</option>
                    <option value="pr">With PR</option>
                  </select>
                </div>
              </div>
              <div className="flex-1 overflow-x-auto overflow-y-auto border border-border-primary rounded-lg">
                <table className="min-w-full divide-y divide-border-primary">
                  <thead className="bg-surface-secondary">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-text-tertiary uppercase tracking-wider">
                        Pane
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-text-tertiary uppercase tracking-wider">
                        Base Branch
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-text-tertiary uppercase tracking-wider">
                        Status
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-text-tertiary uppercase tracking-wider">
                        Commits
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-text-tertiary uppercase tracking-wider">
                        Changes
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-text-tertiary uppercase tracking-wider">
                        Pull Request
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-bg-primary divide-y divide-border-primary">
                    {filteredSessions.map(renderSessionRow)}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="text-center py-8 text-text-tertiary">
              <GitBranch className="w-12 h-12 mx-auto mb-3 text-text-tertiary/50" />
              <p>No active pane branches</p>
            </div>
          )}
        </div>
      ) : null}
    </Card>
  );
});
