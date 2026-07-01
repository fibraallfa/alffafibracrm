import { DashboardRepository } from "@/repositories/dashboard.repository";
import type { DashboardFilters } from "@/repositories/dashboard.repository";

export class DashboardService {
  constructor(private readonly dashboardRepository = new DashboardRepository()) {}

  async getOverview(filters?: DashboardFilters) {
    return this.dashboardRepository.getMetrics(filters);
  }
}
