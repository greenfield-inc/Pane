import type { ReactNode } from 'react';
import { Card } from './ui/Card';
import { Bone, Skeleton, TextBone } from './ui/Skeleton';

const SUMMARY_LABELS = ['Up to date', 'Stale', 'Changes'];
const COLUMNS = ['Pane', 'Base Branch', 'Status', 'Commits', 'Changes', 'Pull Request'];

/**
 * The Project Dashboard while its first read runs, laid out like the loaded
 * card: header, main branch status, summary cards, and the Pane branches table.
 */
export function ProjectDashboardSkeleton({ projectName, status }: { projectName: string; status?: ReactNode }) {
  return (
    <Card className="flex flex-col h-full">
      {status}
      <Skeleton className="flex min-h-0 flex-1 flex-col">
        <div className="px-6 py-4 border-b border-border-primary">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold"><TextBone text="Project Dashboard" /></h2>
              <p className="text-sm"><TextBone text={`Git status for ${projectName}`} /></p>
            </div>
            <Bone className="h-8 w-24 rounded-button" />
          </div>
        </div>

        <div className="p-6 flex-1 flex flex-col overflow-hidden">
          <div className="mb-6 p-4 bg-surface-secondary rounded-lg">
            <div className="flex items-center gap-3">
              <Bone className="w-5 h-5" />
              <div>
                <div className="flex h-6 items-center"><Bone className="h-4 w-44" /></div>
                <div className="mt-1 flex h-5 items-center"><Bone className="h-3.5 w-56" /></div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 mb-6">
            {SUMMARY_LABELS.map(label => (
              <Card key={label} className="p-4">
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-xs font-medium uppercase tracking-wider">
                    <TextBone text={label} />
                    <Bone className="w-2 h-2 rounded-full" />
                  </div>
                  <div className="flex h-8 items-center"><Bone className="h-6 w-12" /></div>
                </div>
              </Card>
            ))}
          </div>

          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium"><TextBone text="Pane Branches (0 of 0)" /></h3>
            <div className="flex items-center gap-2">
              <Bone className="w-4 h-4" />
              <Bone className="h-[30px] w-28" />
            </div>
          </div>
          <div className="flex-1 overflow-hidden border border-border-primary rounded-lg">
            <table className="min-w-full divide-y divide-border-primary">
              <thead className="bg-surface-secondary">
                <tr>
                  {COLUMNS.map(column => (
                    <th key={column} className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider"><TextBone text={column} /></th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border-primary">
                {[32, 40, 28].map(width => (
                  <tr key={width}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Bone className="w-4 h-4 shrink-0" />
                        <div className="flex-1">
                          <div className="flex h-5 items-center"><Bone className="h-3.5" style={{ width: `${width * 4}px` }} /></div>
                          <div className="flex h-4 items-center"><Bone className="h-3 w-24" /></div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3"><Bone className="h-4 w-16" /></td>
                    <td className="px-4 py-3"><Bone className="h-3.5 w-20" /></td>
                    <td className="px-4 py-3"><Bone className="h-3.5 w-12" /></td>
                    <td className="px-4 py-3"><Bone className="h-3.5 w-16" /></td>
                    <td className="px-4 py-3"><Bone className="h-3.5 w-24" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Skeleton>
    </Card>
  );
}
