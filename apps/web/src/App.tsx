import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/components/AuthProvider";
import { useAuth } from "@/lib/auth";
import AppLayout from "@/components/AppLayout";
import LoginPage from "@/pages/LoginPage";
import Dashboard from "@/pages/Dashboard";
import CustomersPage from "@/pages/masters/CustomersPage";
import ContractorsPage from "@/pages/masters/ContractorsPage";
import RoutesPage from "@/pages/masters/RoutesPage";
import BatchesPage from "@/pages/masters/BatchesPage";
import ProductsPage from "@/pages/masters/ProductsPage";
import PriceChartPage from "@/pages/masters/PriceChartPage";
import RecordIndentsPage from "@/pages/sales/RecordIndentsPage";
import AllIndentsPage from "@/pages/sales/AllIndentsPage";
import DirectSalesPage from "@/pages/sales/DirectSalesPage";
import VipContactsPage from "@/pages/masters/VipContactsPage";
import EmployeesPage   from "@/pages/masters/EmployeesPage";
import RecentSalesPage from "@/pages/sales/RecentSalesPage";
import PostIndentPage from "@/pages/sales/PostIndentPage";
import CancellationRequestsPage from "@/pages/sales/CancellationRequestsPage";
import StockDashboard from "@/pages/fgs/StockDashboard";
import StockEntryMilkCurdPage from "@/pages/fgs/StockEntryMilkCurdPage";
import StockEntryOthersPage   from "@/pages/fgs/StockEntryOthersPage";
import StockReportsPage from "@/pages/fgs/StockReportsPage";
import DispatchPage from "@/pages/fgs/DispatchPage";
import DispatchSheetPage from "@/pages/fgs/DispatchSheetPage";
import CreateDispatchPage from "@/pages/fgs/CreateDispatchPage";
import RouteSheetPage from "@/pages/reports/RouteSheetPage";
import GatePassReportPage from "@/pages/reports/GatePassReportPage";
import PriceRevisionsPage from "@/pages/masters/PriceRevisionsPage";
import InvoicesListPage from "@/pages/sales/InvoicesListPage";
import InvoiceDetailPage from "@/pages/sales/InvoiceDetailPage";
import PaymentsOverviewPage from "@/pages/finance/PaymentsOverviewPage";
// import DatabaseHealthPage from "@/pages/system/DatabaseHealthPage";
import {
  DailySalesStatement, DayRouteCashSales, OfficerWiseSales,
  CashSalesReport, CreditSalesReport, SalesRegister,
  TalukaAgentSales, AdhocSalesReport, GSTStatement,
} from "@/pages/sales-reports/SalesReports";
import {
  TimeWindowsPage, NotificationsPage, DealerNotificationsPage,
  BannerManagementPage, RolesPage, UserManagementPage,
} from "@/pages/system/SystemPages";
import NotFound from "@/pages/NotFound";
import { Skeleton } from "@/components/ui/skeleton";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 2,
      retry: (failureCount, error) => {
        if ((error as { status?: number })?.status === 401) return false;
        return failureCount < 1;
      },
    },
  },
});

function AppInner() {
  const { user, loading, login } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="space-y-2 w-64">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      </div>
    );
  }

  if (!user) return <LoginPage onLogin={login} />;

  return (
    <BrowserRouter>
      <AppLayout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          {/* Masters */}
          <Route path="/masters/customers" element={<CustomersPage tab="list" />} />
          <Route path="/masters/customers/new" element={<CustomersPage tab="new" />} />
          <Route path="/masters/customers/assign-route" element={<CustomersPage tab="assign-route" />} />
          <Route path="/masters/contractors" element={<ContractorsPage tab="list" />} />
          <Route path="/masters/contractors/new" element={<ContractorsPage tab="new" />} />
          <Route path="/masters/vip-contacts" element={<VipContactsPage />} />
          <Route path="/masters/employees"    element={<EmployeesPage />} />
          <Route path="/masters/routes" element={<RoutesPage tab="list" />} />
          <Route path="/masters/routes/new" element={<RoutesPage tab="new" />} />
          <Route path="/masters/batches" element={<BatchesPage tab="list" />} />
          <Route path="/masters/batches/new" element={<BatchesPage tab="new" />} />
          <Route path="/masters/products" element={<ProductsPage tab="list" />} />
          <Route path="/masters/products/add" element={<ProductsPage tab="add" />} />
          <Route path="/masters/price-chart" element={<PriceChartPage />} />
          <Route path="/masters/price-revisions"  element={<PriceRevisionsPage />} />
          {/* Sales */}
          <Route path="/sales/record-indents" element={<RecordIndentsPage />} />
          <Route path="/sales/post-indent" element={<PostIndentPage />} />
          <Route path="/sales/all-indents" element={<AllIndentsPage />} />
          <Route path="/sales/direct-sales/gate-pass" element={<DirectSalesPage tab="gate-pass" />} />
          <Route path="/sales/direct-sales/cash-customer" element={<DirectSalesPage tab="cash-customer" />} />
          <Route path="/sales/direct-sales/modify" element={<DirectSalesPage tab="modify" />} />
          <Route path="/sales/direct-sales/recent" element={<RecentSalesPage />} />
          <Route path="/sales/direct-sales/vip-sample"        element={<DirectSalesPage tab="vip-sample" />} />
          <Route path="/sales/direct-sales/employee-subsidy"  element={<DirectSalesPage tab="employee-subsidy" />} />
          <Route path="/sales/cancellations" element={<CancellationRequestsPage />} />
          <Route path="/sales/invoices"      element={<InvoicesListPage />} />
          <Route path="/sales/invoices/:id"  element={<InvoiceDetailPage />} />
          {/* FGS */}
          <Route path="/fgs/dashboard" element={<StockDashboard />} />
          <Route path="/fgs/stock-entry"            element={<Navigate to="/fgs/stock-entry/milk-curd" replace />} />
          <Route path="/fgs/stock-entry/milk-curd"  element={<StockEntryMilkCurdPage />} />
          <Route path="/fgs/stock-entry/others"     element={<StockEntryOthersPage   />} />
          <Route path="/fgs/reports" element={<StockReportsPage />} />
          <Route path="/fgs/dispatch" element={<DispatchPage />} />
          <Route path="/fgs/dispatch-sheet" element={<DispatchSheetPage />} />
          <Route path="/fgs/dispatch/create" element={<CreateDispatchPage />} />
          {/* Finance */}
          <Route path="/finance/payments" element={<PaymentsOverviewPage />} />
          {/* Reports */}
          <Route path="/reports/route-sheet" element={<RouteSheetPage />} />
          <Route path="/reports/gate-pass" element={<GatePassReportPage />} />
          {/* Sales Reports */}
          <Route path="/sales-reports/daily-statement" element={<DailySalesStatement />} />
          <Route path="/sales-reports/day-route-cash" element={<DayRouteCashSales />} />
          <Route path="/sales-reports/officer-wise" element={<OfficerWiseSales />} />
          <Route path="/sales-reports/cash-sales" element={<CashSalesReport />} />
          <Route path="/sales-reports/credit-sales" element={<CreditSalesReport />} />
          <Route path="/sales-reports/register" element={<SalesRegister />} />
          <Route path="/sales-reports/taluka-agent" element={<TalukaAgentSales />} />
          <Route path="/sales-reports/adhoc" element={<AdhocSalesReport />} />
          <Route path="/sales-reports/gst" element={<GSTStatement />} />
          {/* System */}
          <Route path="/system/time-windows" element={<TimeWindowsPage />} />
          <Route path="/system/notifications" element={<NotificationsPage />} />
          <Route path="/system/dealer-notifications" element={<DealerNotificationsPage />} />
          <Route path="/system/banners" element={<BannerManagementPage />} />
          <Route path="/system/roles" element={<RolesPage />} />
          <Route path="/system/users" element={<UserManagementPage />} />
          {/* <Route path="/system/db-health" element={<DatabaseHealthPage />} /> */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </AppLayout>
    </BrowserRouter>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <AuthProvider>
        <AppInner />
      </AuthProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
