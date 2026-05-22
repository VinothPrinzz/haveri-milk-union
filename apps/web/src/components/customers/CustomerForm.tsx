// apps/web/src/components/customers/CustomerForm.tsx

import { useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import PageHeader, { FormSection, Field, FormFooter } from "@/components/PageHeader";

interface Props {
  initialData?: Customer;
  autoCode?: string;
  selectedLetter?: string;
  onLetterChange?: (l: string) => void;
  onSubmit: (data: CustomerFormData) => void | Promise<void>;
  isSubmitting?: boolean;
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
      const first = Object.values(errors)[0] as any;
      if (first?.message) toast.error(first.message);
    }
  );

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title={isEdit ? "Edit Customer" : "New Customer"}
        subtitle="Enter customer details"
      />

      <Form {...form}>
        <form 
          onSubmit={submit} 
          className="flex-1 overflow-auto p-4 space-y-3 pb-20"
        >
          {/* Identity */}
          <FormSection title="Identity" cols={3}>
            {!isEdit && (
              <Field label="Customer Code (Auto)">
                <div className="flex gap-2 items-center">
                  <Select value={selectedLetter} onValueChange={onLetterChange}>
                    <SelectTrigger className="erp-input w-20">
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
                  <Input value={autoCode ?? ""} disabled className="erp-input bg-muted flex-1" />
                </div>
              </Field>
            )}

            {isEdit && (
              <Field label="Code">
                <Input value={initialData?.code ?? ""} disabled className="erp-input bg-muted" />
              </Field>
            )}

            <Field label="Name" required error={form.formState.errors.name?.message}>
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Input className="erp-input" placeholder="Customer name" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </Field>

            <Field label="Phone" required error={form.formState.errors.phone?.message}>
              <FormField
                control={form.control}
                name="phone"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Input className="erp-input" placeholder="10-digit phone" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </Field>

            <Field label="Email ID" error={form.formState.errors.email?.message}>
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Input className="erp-input" type="email" placeholder="name@example.com" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </Field>
          </FormSection>

          {/* Business */}
          <FormSection title="Business" cols={3}>
            <Field label="Customer Type" required error={form.formState.errors.type?.message}>
              <FormField
                control={form.control}
                name="type"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <F9SearchSelect
                        value={field.value || null}
                        onChange={v => field.onChange(v ?? "Retail-Dealer")}
                        options={CUSTOMER_TYPES}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </Field>

            <Field label="Rate Category" error={form.formState.errors.rateCategory?.message}>
              <FormField
                control={form.control}
                name="rateCategory"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <F9SearchSelect
                        value={field.value || null}
                        onChange={v => field.onChange(v ?? "Retail-Dealer")}
                        options={rateCategoryOptions}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </Field>

            <Field label="Pay Mode" error={form.formState.errors.payMode?.message}>
              <FormField
                control={form.control}
                name="payMode"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger className="erp-input">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="Cash">Cash</SelectItem>
                          <SelectItem value="Credit">Credit</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormControl>
                  </FormItem>
                )}
              />
            </Field>

            <Field label="Officer Name" error={form.formState.errors.officerName?.message}>
              <FormField
                control={form.control}
                name="officerName"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <F9SearchSelect
                        value={field.value || null}
                        onChange={v => field.onChange(v ?? "")}
                        options={officerOptions}
                        allowAll
                        allLabel="— None —"
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </Field>

            <Field label="Bank" error={form.formState.errors.bank?.message}>
              <FormField
                control={form.control}
                name="bank"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Input className="erp-input" placeholder="Bank name" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </Field>

            <Field label="Account No." error={form.formState.errors.accountNo?.message}>
              <FormField
                control={form.control}
                name="accountNo"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Input className="erp-input" placeholder="Bank account number" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </Field>

            <Field label="Credit Limit (₹)" error={form.formState.errors.creditLimit?.message}>
              <FormField
                control={form.control}
                name="creditLimit"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Input
                        className="erp-input"
                        type="number"
                        min={0}
                        step="0.01"
                        {...field}
                        onChange={e => field.onChange(parseFloat(e.target.value) || 0)}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </Field>
          </FormSection>

          {/* Address */}
          <FormSection title="Address" cols={3}>
            <Field label="Address Type" error={form.formState.errors.addressType?.message}>
              <FormField
                control={form.control}
                name="addressType"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <F9SearchSelect
                        value={field.value || null}
                        onChange={v => field.onChange(v ?? "")}
                        options={addressTypeOptions}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </Field>

            <Field label="State" required error={form.formState.errors.state?.message}>
              <FormField
                control={form.control}
                name="state"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <F9SearchSelect
                        value={field.value || null}
                        onChange={v => field.onChange(v ?? "Karnataka")}
                        options={stateOptions}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </Field>

            <Field label="Taluka" error={form.formState.errors.zoneId?.message}>
              <FormField
                control={form.control}
                name="zoneId"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <F9SearchSelect
                        value={field.value || null}
                        onChange={v => field.onChange(v ?? "")}
                        options={talukaOptions}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </Field>

            <Field label="District" error={form.formState.errors.city?.message}>
              <FormField
                control={form.control}
                name="city"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <F9SearchSelect
                        value={field.value || null}
                        onChange={v => field.onChange(v ?? "")}
                        options={cityOptions}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </Field>

            <Field label="Area" error={form.formState.errors.area?.message}>
              <FormField
                control={form.control}
                name="area"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Input className="erp-input" placeholder="Area / locality" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </Field>

            <Field label="House No." error={form.formState.errors.houseNo?.message}>
              <FormField
                control={form.control}
                name="houseNo"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Input className="erp-input" placeholder="12/A" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </Field>

            <Field label="Street" error={form.formState.errors.street?.message}>
              <FormField
                control={form.control}
                name="street"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Input className="erp-input" placeholder="Street name" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </Field>

            <Field 
              label="Full Address (optional)" 
              error={form.formState.errors.address?.message}
              className="md:col-span-3"
            >
              <FormField
                control={form.control}
                name="address"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Input className="erp-input" placeholder="e.g. MG Road, opp. Bus Stand, Haveri" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </Field>
          </FormSection>

          {/* Assignment */}
          <FormSection title="Assignment" cols={2}>
            <Field label="Primary Route" error={form.formState.errors.routeId?.message}>
              <FormField
                control={form.control}
                name="routeId"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <F9SearchSelect
                        value={field.value || null}
                        onChange={v => field.onChange(v ?? "")}
                        options={routeOptions}
                        allowAll
                        allLabel="— Unassigned —"
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </Field>

            <Field label="Active">
              <FormField
                control={form.control}
                name="active"
                render={({ field }) => (
                  <FormItem className="flex items-center gap-3">
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                    <FormLabel className="!mt-0">Active</FormLabel>
                  </FormItem>
                )}
              />
            </Field>
          </FormSection>
        </form>
      </Form>

      <FormFooter>
        {onCancel && (
          <Button type="button" variant="outline" size="sm" className="h-8" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="button" size="sm" className="h-8" disabled={isSubmitting} onClick={() => submit()}>
          {isSubmitting ? "Saving…" : (isEdit ? "Save Changes" : "Save Customer")}
        </Button>
      </FormFooter>
    </div>
  );
}