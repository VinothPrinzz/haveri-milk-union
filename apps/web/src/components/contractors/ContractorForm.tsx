// apps/web/src/components/contractors/ContractorForm.tsx

import { useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import PageHeader, { FormSection, Field, FormFooter } from "@/components/PageHeader";

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
    <div className="flex flex-col h-full">
      <PageHeader
        title={isEdit ? "Edit Contractor" : "New Contractor"}
        subtitle="Enter contractor details"
      />

      <Form {...form}>
        <form 
          onSubmit={submit} 
          className="flex-1 overflow-auto p-4 space-y-3 pb-20"
        >
          {/* Identity */}
          <FormSection title="Identity" cols={3}>
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
                      <Input className="erp-input" placeholder="Contractor name" {...field} />
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

            <Field label="License Number" error={form.formState.errors.licenseNumber?.message}>
              <FormField
                control={form.control}
                name="licenseNumber"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Input className="erp-input" placeholder="KA-TRP-2026-001" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </Field>
          </FormSection>

          {/* Business */}
          <FormSection title="Business" cols={3}>
            <Field label="Bank Name" error={form.formState.errors.bankName?.message}>
              <FormField
                control={form.control}
                name="bankName"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Input className="erp-input" placeholder="State Bank of India" {...field} />
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

            <Field label="Rate per Km (₹)" error={form.formState.errors.ratePerKm?.message}>
              <FormField
                control={form.control}
                name="ratePerKm"
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

            <Field label="Vehicle Number" error={form.formState.errors.vehicleNumber?.message}>
              <FormField
                control={form.control}
                name="vehicleNumber"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Input className="erp-input" placeholder="KA-25-AB-1234" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </Field>
          </FormSection>

          {/* Contract Period */}
          <FormSection title="Contract Period" cols={2}>
            <Field label="Period From" error={form.formState.errors.periodFrom?.message}>
              <FormField
                control={form.control}
                name="periodFrom"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Input className="erp-input" type="date" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </Field>

            <Field label="Period To" error={form.formState.errors.periodTo?.message}>
              <FormField
                control={form.control}
                name="periodTo"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Input className="erp-input" type="date" {...field} />
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
                      <Input className="erp-input" placeholder="e.g. Haveri Bus Stand, Haveri" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </Field>
          </FormSection>

          {/* Assign Routes + Active */}
          <FormSection title="Assignment" cols={1}>
            <Field label="Assign Routes" error={form.formState.errors.routeIds?.message}>
              <FormField
                control={form.control}
                name="routeIds"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <F9SearchMultiSelect
                        values={field.value ?? []}
                        onChange={field.onChange}
                        options={routeOptions}
                        placeholder={isEdit ? "Click to manage routes" : "Press F9 to select routes"}
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
          {isSubmitting ? "Saving…" : (isEdit ? "Save Changes" : "Save Contractor")}
        </Button>
      </FormFooter>
    </div>
  );
}