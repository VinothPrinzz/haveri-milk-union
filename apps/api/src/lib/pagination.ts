import { z } from "zod";

/**
 * Standard pagination query schema — used by every list endpoint.
 * Frontend tables are built to consume { data, total, page, limit }.
 */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type PaginationQuery = z.infer<typeof paginationSchema>;

export function paginationMeta(total: number, page: number, limit: number) {
  return {
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

export function offsetFromPage(page: number, limit: number): number {
  return (page - 1) * limit;
}
