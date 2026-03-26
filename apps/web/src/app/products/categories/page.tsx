"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader, Button } from "@/components/ui";
import { Plus, Pencil } from "lucide-react";

export default function CategoriesPage() {
  const { data } = useQuery({ queryKey: ["categories"], queryFn: () => api.get("/api/v1/categories") });
  const categories = data?.categories ?? [];
  return (
    <>
      <PageHeader icon="🏷️" title="Categories" subtitle="Manage product categories"
        actions={<Button size="sm"><Plus className="h-3.5 w-3.5" /> Add Category</Button>} />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {categories.map((c: any) => (
          <div key={c.id} className="bg-card rounded-[10px] border border-border shadow-card p-4 flex items-center justify-between cursor-pointer hover:border-brand/30 transition-colors">
            <div className="flex items-center gap-3">
              <span className="text-3xl">{c.icon || "📦"}</span>
              <div><div className="text-[13px] font-bold text-fg">{c.name}</div><div className="text-[10px] text-muted-fg mt-0.5">Active</div></div>
            </div>
            <button className="p-1.5 rounded-md border border-border hover:bg-muted"><Pencil className="h-3.5 w-3.5 text-muted-fg" /></button>
          </div>
        ))}
      </div>
    </>
  );
}
