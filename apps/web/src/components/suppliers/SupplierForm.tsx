// apps/web/src/components/suppliers/SupplierForm.tsx
// Stock vendor master form. Mirrors ContractorForm's layout/idioms, trimmed
// to the few fields a supplier needs (no routes/zone/period).

import { useSaveShortcut } from "@/lib/useKeyboardNav";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
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
} from "@/components/ui/form";
import { supplierSchema, type SupplierFormData } from "@/lib/validations";
import PageHeader, { FormSection, Field, FormFooter } from "@/components/PageHeader";
import type { Supplier } from "@/services/api";

interface Props {
  initialData?: Supplier;
  onSubmit: (data: SupplierFormData) => void | Promise<void>;
  isSubmitting?: boolean;
  onCancel?: () => void;
}

export function SupplierForm({ initialData, onSubmit, isSubmitting, onCancel }: Props) {
  const isEdit = Boolean(initialData);

  const form = useForm<SupplierFormData>({
    resolver: zodResolver(supplierSchema),
    defaultValues: initialData
      ? {
          name: initialData.name,
          phone: initialData.phone ?? "",
          gstNo: initialData.gstNo ?? "",
          accountNo: initialData.accountNo ?? "",
          address: initialData.address ?? "",
          active: initialData.status === "Active",
        }
      : { active: true },
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

  useSaveShortcut(() => submit(), !isSubmitting);

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title={isEdit ? "Edit Supplier" : "New Supplier"}
        subtitle="Enter supplier details"
      />

      <Form {...form}>
        <form onSubmit={submit} className="flex-1 overflow-auto p-4 space-y-3 pb-20">
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
                      <Input className="erp-input" placeholder="Supplier name" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </Field>

            <Field label="Phone" error={form.formState.errors.phone?.message}>
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
          </FormSection>

          <FormSection title="Business" cols={3}>
            <Field label="GST No." error={form.formState.errors.gstNo?.message}>
              <FormField
                control={form.control}
                name="gstNo"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Input className="erp-input" placeholder="29ABCDE1234F1Z5" {...field} />
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
          </FormSection>

          <FormSection title="Address" cols={1}>
            <Field label="Address" error={form.formState.errors.address?.message}>
              <FormField
                control={form.control}
                name="address"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Input className="erp-input" placeholder="e.g. APMC Yard, Haveri" {...field} />
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
          {isSubmitting ? "Saving…" : (isEdit ? "Save Changes" : "Save Supplier")}
        </Button>
      </FormFooter>
    </div>
  );
}
