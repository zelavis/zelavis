import { DataRow } from "#/components/DashboardPage";

export const handle = {
  pageLabel: "Workloads",
  sidebarTrail: ["Backend", "Workloads"],
  slots: [{ id: "settings", label: "Settings" }],
} as const;

export default function WorkloadSettingsRoute() {
  return (
    <section
      data-dashboard-slot-layout
      className="mx-auto w-full max-w-5xl"
    >
      <div
        data-dashboard-slot="settings"
        className="overflow-hidden rounded-md border"
      >
        <DataRow
          label="Runner"
          detail="Development stub runner. Isolated runner adapters come next."
        />
        <DataRow
          label="Scope"
          detail="Workloads are project-scoped and served by the long-running Zelavis runtime."
        />
        <DataRow
          label="Provider sync"
          detail="External serverless providers belong behind optional Workloads provider plugins."
        />
      </div>
    </section>
  );
}
