// apps/web/src/components/contractors/ContractorForm.tsx
// ════════════════════════════════════════════════════════════════════
// Contractor Form (Marketing v1.4) — shared between New + Edit flows.
//
// Sections:
//   1. Identity       — name, phone, email, license number
//   2. Business       — bank, account no, rate/km, vehicle number
//   3. Period         — period from, period to
//   4. Address        — address type (F9), state (F9), city (F9),
//                       area, house no, street, full address
//   + Assignment      — Assigned Routes (multi-F9), Active toggle
// ════════════════════════════════════════════════════════════════════

import { useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import { F9SearchSelect, F9SearchMultiSelect, type F9Option } from "@/components/F9SearchSelect";
import {
  fetchRoutes,
  fetchMarketingSettings,
  type Contractor,
} from "@/services/api";
import { contractorSchema, type ContractorFormData } from "@/lib/validations";

interface Props {
  initialData?: Contractor;
  onSubmit: (data: ContractorFormData) => void | Promise<void>;
  isSubmitting?: boolean;
  onCancel?: () => void;
}

export function ContractorForm({ initialData, onSubmit, isSubmitting, onCancel }: Props) {
  const isEdit = Boolean(initialData);
  const { data: routes = [] } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });
  const { data: mkt } = useQuery({
    queryKey: ["marketing-settings"],
    queryFn: fetchMarketingSettings,
    staleTime: Infinity,
  });

  const routeOptions: F9Option[] = useMemo(
    () => routes.map((r: any) => ({ value: r.id, label: r.name, sublabel: r.code })),
    [routes]
  );
  const stateOptions: F9Option[] = useMemo(
    () => (mkt?.states ?? ["Karnataka"]).map(s => ({ value: s, label: s })),
    [mkt]
  );
  const cityOptions: F9Option[] = useMemo(
    () => (mkt?.cities ?? []).map(c => ({ value: c, label: c })),
    [mkt]
  );
  const addressTypeOptions: F9Option[] = useMemo(
    () => (mkt?.address_types ?? ["Office", "Residence"]).map(t => ({ value: t, label: t })),
    [mkt]
  );

  const form = useForm<ContractorFormData>({
    resolver: zodResolver(contractorSchema),
    defaultValues: initialData
      ? {
          name: initialData.name,
          phone: initialData.phone,
          email: initialData.email ?? "",
          licenseNumber: initialData.licenseNumber ?? "",
          bankName: initialData.bankName ?? "",
          accountNo: initialData.accountNo ?? "",
          ratePerKm: initialData.ratePerKm ?? 0,
          vehicleNumber: initialData.vehicleNumber ?? "",
          periodFrom: initialData.periodFrom ?? "",
          periodTo: initialData.periodTo ?? "",
          addressType: (initialData.addressType ?? "") as any,
          state: initialData.state ?? "Karnataka",
          city: initialData.city ?? "",
          area: initialData.area ?? "",
          houseNo: initialData.houseNo ?? "",
          street: initialData.street ?? "",
          address: initialData.address ?? "",
          routeIds: initialData.routeIds ?? [],
          active: initialData.status === "Active",
        }
      : {
          active: true,
          state: "Karnataka",
          ratePerKm: 0,
          routeIds: [],
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
      const first = Object.values(errors)[0] as any;
      if (first?.message) toast.error(first.message);
    }
  );

  return (
    <Form {...form}>
      <form onSubmit={submit} className="space-y-4">
        {/* ═══════ 1. Identity ═══════ */}
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm">Identity</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {isEdit && (
              <div>
                <label className="text-sm font-medium mb-1.5 block">Code</label>
                <Input value={initialData?.code ?? ""} disabled className="bg-muted" />
              </div>
            )}

            <FormField control={form.control} name="name" render={({ field }) => (
              <FormItem>
                <FormLabel>Name</FormLabel>
                <FormControl><Input placeholder="Contractor name" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />

            <FormField control={form.control} name="phone" render={({ field }) => (
              <FormItem>
                <FormLabel>Phone</FormLabel>
                <FormControl><Input placeholder="10-digit phone" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />

            <FormField control={form.control} name="email" render={({ field }) => (
              <FormItem>
                <FormLabel>Email ID</FormLabel>
                <FormControl><Input type="email" placeholder="name@example.com" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />

            <FormField control={form.control} name="licenseNumber" render={({ field }) => (
              <FormItem>
                <FormLabel>License Number</FormLabel>
                <FormControl><Input placeholder="KA-TRP-2026-001" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
          </CardContent>
        </Card>

        {/* ═══════ 2. Business ═══════ */}
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm">Business</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <FormField control={form.control} name="bankName" render={({ field }) => (
              <FormItem>
                <FormLabel>Bank Name</FormLabel>
                <FormControl><Input placeholder="State Bank of India" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />

            <FormField control={form.control} name="accountNo" render={({ field }) => (
              <FormItem>
                <FormLabel>Account No.</FormLabel>
                <FormControl><Input placeholder="Bank account number" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />

            <FormField control={form.control} name="ratePerKm" render={({ field }) => (
              <FormItem>
                <FormLabel>Rate per Km (₹)</FormLabel>
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
            )} />

            <FormField control={form.control} name="vehicleNumber" render={({ field }) => (
              <FormItem>
                <FormLabel>Vehicle Number</FormLabel>
                <FormControl><Input placeholder="KA-25-AB-1234" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
          </CardContent>
        </Card>

        {/* ═══════ 3. Period ═══════ */}
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm">Contract Period</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FormField control={form.control} name="periodFrom" render={({ field }) => (
              <FormItem>
                <FormLabel>Period From</FormLabel>
                <FormControl><Input type="date" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />

            <FormField control={form.control} name="periodTo" render={({ field }) => (
              <FormItem>
                <FormLabel>Period To</FormLabel>
                <FormControl><Input type="date" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
          </CardContent>
        </Card>

        {/* ═══════ 4. Address ═══════ */}
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm">Address</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <FormField control={form.control} name="addressType" render={({ field }) => (
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
            )} />

            <FormField control={form.control} name="state" render={({ field }) => (
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
            )} />

            <FormField control={form.control} name="city" render={({ field }) => (
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
            )} />

            <FormField control={form.control} name="area" render={({ field }) => (
              <FormItem>
                <FormLabel>Area</FormLabel>
                <FormControl><Input placeholder="Area / locality" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />

            <FormField control={form.control} name="houseNo" render={({ field }) => (
              <FormItem>
                <FormLabel>House No.</FormLabel>
                <FormControl><Input placeholder="12/A" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />

            <FormField control={form.control} name="street" render={({ field }) => (
              <FormItem>
                <FormLabel>Street</FormLabel>
                <FormControl><Input placeholder="Street name" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />

            <FormField control={form.control} name="address" render={({ field }) => (
              <FormItem className="md:col-span-3">
                <FormLabel>Full Address (optional, free-form)</FormLabel>
                <FormControl><Input placeholder="e.g. Haveri Bus Stand, Haveri" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
          </CardContent>
        </Card>

        {/* ═══════ Assign Routes + Active ═══════ */}
        <Card>
          <CardContent className="pt-6 space-y-4">
            <FormField control={form.control} name="routeIds" render={({ field }) => (
              <FormItem>
                <FormLabel>Assign Routes</FormLabel>
                <FormControl>
                  <F9SearchMultiSelect
                    values={field.value ?? []}
                    onChange={field.onChange}
                    options={routeOptions}
                    placeholder={isEdit ? "Click to manage routes" : "Press F9 to select routes"}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )} />

            <FormField control={form.control} name="active" render={({ field }) => (
              <FormItem className="flex items-center gap-3">
                <FormControl>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
                <FormLabel className="!mt-0">Active</FormLabel>
              </FormItem>
            )} />
          </CardContent>
        </Card>

        <div className="flex gap-2 justify-end">
          {onCancel && <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>}
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Saving..." : isEdit ? "Save Changes" : "+ Save Contractor"}
          </Button>
        </div>
      </form>
    </Form>
  );
}