// apps/web/src/components/customers/CustomerForm.tsx
// ════════════════════════════════════════════════════════════════════
// Customer Form (Marketing v1.4) — shared between New + Edit flows.
//
// Organised into three visual sections:
//   1. Identity      — code, name, phone, email
//   2. Business      — type, rate category, pay mode, officer, bank,
//                      account no, credit limit
//   3. Address       — address type, state, taluka, city, area,
//                      house no, street, free-form address
//   + Assignment     — primary route, active switch
//
// All dropdown pickers use F9SearchSelect per the v1.4 spec.
// ════════════════════════════════════════════════════════════════════

import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import {
  fetchRoutes,
  fetchZones,
  fetchMarketingSettings,
  getRateCategories,
  getOfficers,
  type Customer,
} from "@/services/api";
import { customerSchema, type CustomerFormData } from "@/lib/validations";

interface Props {
  /** Optional existing customer for edit mode. If absent, form is in create mode. */
  initialData?: Customer;
  /** Auto-generated next code (create mode only). */
  autoCode?: string;
  /** Selectable letter prefix for code (create mode only). */
  selectedLetter?: string;
  onLetterChange?: (letter: string) => void;
  /** Called with validated form data. */
  onSubmit: (data: CustomerFormData) => void | Promise<void>;
  /** Submit button loading state. */
  isSubmitting?: boolean;
  /** Cancel button; when provided, shown alongside Save. */
  onCancel?: () => void;
}

const CUSTOMER_TYPES = [
  { value: "Retail-Dealer", label: "Retail-Dealer" },
  { value: "Credit Inst-MRP", label: "Credit Inst-MRP" },
  { value: "Credit Inst-Dealer", label: "Credit Inst-Dealer" },
  { value: "Parlour-Dealer", label: "Parlour-Dealer" },
];

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

export function CustomerForm({
  initialData,
  autoCode,
  selectedLetter = "A",
  onLetterChange,
  onSubmit,
  isSubmitting,
  onCancel,
}: Props) {
  const isEdit = Boolean(initialData);

  // ── Data sources ──────────────────────────────────────────────
  const { data: zones = [] } = useQuery({ queryKey: ["zones"], queryFn: fetchZones });
  const { data: routes = [] } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });
  const { data: mkt } = useQuery({
    queryKey: ["marketing-settings"],
    queryFn: fetchMarketingSettings,
    staleTime: Infinity,
  });
  const rateCategories = getRateCategories();
  const officers = getOfficers();

  // ── F9 option lists ───────────────────────────────────────────
  const talukaOptions: F9Option[] = useMemo(
    () => zones.map(z => ({ value: z.id, label: z.name })),
    [zones]
  );

  const routeOptions: F9Option[] = useMemo(
    () =>
      routes.map(r => ({
        value: r.id,
        label: r.name,
        sublabel: r.code,
      })),
    [routes]
  );

  const rateCategoryOptions: F9Option[] = useMemo(
    () => rateCategories.map((r: any) => ({ value: r.name ?? r, label: r.name ?? r })),
    [rateCategories]
  );

  const officerOptions: F9Option[] = useMemo(
    () => officers.map((o: any) => ({ value: o.name ?? o, label: o.name ?? o })),
    [officers]
  );

  const stateOptions: F9Option[] = useMemo(
    () => (mkt?.states ?? []).map((s: string) => ({ value: s, label: s })),
    [mkt]
  );

  const cityOptions: F9Option[] = useMemo(
    () => (mkt?.cities ?? []).map((c: string) => ({ value: c, label: c })),
    [mkt]
  );

  const addressTypeOptions: F9Option[] = useMemo(
    () => (mkt?.address_types ?? ["Office", "Residence"]).map((t: string) => ({
      value: t,
      label: t,
    })),
    [mkt]
  );

  // ── Form ──────────────────────────────────────────────────────
  const form = useForm<CustomerFormData>({
    resolver: zodResolver(customerSchema),
    defaultValues: initialData
      ? {
          name: initialData.name,
          phone: initialData.phone,
          email: initialData.email ?? "",
          type: initialData.type as any,
          rateCategory: initialData.rateCategory,
          payMode: initialData.payMode,
          officerName: initialData.officerName ?? "",
          bank: initialData.bank ?? "",
          accountNo: initialData.accountNo ?? "",
          creditLimit: initialData.creditLimit ?? 0,
          addressType: (initialData.addressType ?? "") as any,
          state: initialData.state ?? "Karnataka",
          zoneId: initialData.zoneId ?? "",
          city: initialData.city ?? "",
          area: initialData.area ?? "",
          houseNo: initialData.houseNo ?? "",
          street: initialData.street ?? "",
          address: initialData.address ?? "",
          routeId: initialData.routeId ?? "",
          active: initialData.status === "Active",
        }
      : {
          active: true,
          payMode: "Cash",
          state: "Karnataka",
          creditLimit: 0,
        },
  });

  const submit = form.handleSubmit(
    async data => {
      try {
        await onSubmit(data);
      } catch (e: any) {
        toast.error(e?.message || "Failed to save");
      }
    },
    errors => {
      // Surface the first validation error so the user sees what's missing
      const first = Object.values(errors)[0] as any;
      if (first?.message) toast.error(first.message);
    }
  );

  return (
    <Form {...form}>
      <form onSubmit={submit} className="space-y-4">
        {/* ═══════ 1. Identity ═══════ */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Identity</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {!isEdit && (
              <div>
                <label className="text-sm font-medium mb-1.5 block">Customer Code (Auto)</label>
                <div className="flex gap-2 items-center">
                  <Select value={selectedLetter} onValueChange={onLetterChange}>
                    <SelectTrigger className="w-20">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-h-60">
                      {LETTERS.map(l => (
                        <SelectItem key={l} value={l}>
                          {l}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input value={autoCode ?? ""} disabled className="bg-muted flex-1" />
                </div>
              </div>
            )}

            {isEdit && (
              <div>
                <label className="text-sm font-medium mb-1.5 block">Code</label>
                <Input value={initialData?.code ?? ""} disabled className="bg-muted" />
              </div>
            )}

            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="Customer name" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="phone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Phone</FormLabel>
                  <FormControl>
                    <Input placeholder="10-digit phone" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email ID</FormLabel>
                  <FormControl>
                    <Input type="email" placeholder="name@example.com" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        {/* ═══════ 2. Business ═══════ */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Business</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <FormField
              control={form.control}
              name="type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Customer Type</FormLabel>
                  <FormControl>
                    <F9SearchSelect
                      value={field.value || null}
                      onChange={v => field.onChange(v ?? "Retail-Dealer")}
                      options={CUSTOMER_TYPES}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="rateCategory"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Rate Category</FormLabel>
                  <FormControl>
                    <F9SearchSelect
                      value={field.value || null}
                      onChange={v => field.onChange(v ?? "Retail-Dealer")}
                      options={rateCategoryOptions}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="payMode"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Pay Mode</FormLabel>
                  <FormControl>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Cash">Cash</SelectItem>
                        <SelectItem value="Credit">Credit</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="officerName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Officer Name</FormLabel>
                  <FormControl>
                    <F9SearchSelect
                      value={field.value || null}
                      onChange={v => field.onChange(v ?? "")}
                      options={officerOptions}
                      allowAll
                      allLabel="— None —"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="bank"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Bank</FormLabel>
                  <FormControl>
                    <Input placeholder="Bank name" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="accountNo"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Account No.</FormLabel>
                  <FormControl>
                    <Input placeholder="Bank account number" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="creditLimit"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Credit Limit (₹)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      {...field}
                      onChange={e => field.onChange(parseFloat(e.target.value) || 0)}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        {/* ═══════ 3. Address ═══════ */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Address</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <FormField
              control={form.control}
              name="addressType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Address Type</FormLabel>
                  <FormControl>
                    <F9SearchSelect
                      value={field.value || null}
                      onChange={v => field.onChange(v ?? "")}
                      options={addressTypeOptions}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="state"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>State</FormLabel>
                  <FormControl>
                    <F9SearchSelect
                      value={field.value || null}
                      onChange={v => field.onChange(v ?? "Karnataka")}
                      options={stateOptions}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="zoneId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Taluka</FormLabel>
                  <FormControl>
                    <F9SearchSelect
                      value={field.value || null}
                      onChange={v => field.onChange(v ?? "")}
                      options={talukaOptions}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="city"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>City</FormLabel>
                  <FormControl>
                    <F9SearchSelect
                      value={field.value || null}
                      onChange={v => field.onChange(v ?? "")}
                      options={cityOptions}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="area"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Area</FormLabel>
                  <FormControl>
                    <Input placeholder="Area / locality" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="houseNo"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>House No.</FormLabel>
                  <FormControl>
                    <Input placeholder="12/A" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="street"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Street</FormLabel>
                  <FormControl>
                    <Input placeholder="Street name" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="address"
              render={({ field }) => (
                <FormItem className="md:col-span-3">
                  <FormLabel>Full Address (optional, free-form)</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. MG Road, opp. Bus Stand, Haveri" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        {/* ═══════ Assignment + submit ═══════ */}
        <Card>
          <CardContent className="pt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
            <FormField
              control={form.control}
              name="routeId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Primary Route</FormLabel>
                  <FormControl>
                    <F9SearchSelect
                      value={field.value || null}
                      onChange={v => field.onChange(v ?? "")}
                      options={routeOptions}
                      allowAll
                      allLabel="— Unassigned —"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="active"
              render={({ field }) => (
                <FormItem className="flex items-center gap-3 pt-6">
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                  <FormLabel className="!mt-0">Active</FormLabel>
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <div className="flex gap-2 justify-end">
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Saving..." : isEdit ? "Save Changes" : "+ Save Customer"}
          </Button>
        </div>
      </form>
    </Form>
  );
}