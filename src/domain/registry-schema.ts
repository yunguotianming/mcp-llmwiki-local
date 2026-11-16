import { z } from 'zod'

const identifier = z.string().trim().min(1)
const summaryTier = (max: number) => z.strictObject({ text: z.string().max(max), origin: z.enum(['generated', 'manual', 'legacy']),
  locked: z.boolean(), sourceVersion: identifier.nullable() })
export const libraryOrganizationSchema = z.strictObject({
  groupId: identifier.nullable().optional(), pinned: z.boolean().optional(), order: z.number().int().nonnegative().optional(),
  summary: z.strictObject({ short: summaryTier(80).optional(), long: summaryTier(1200).optional() }).optional(),
  publishedVersion: identifier.nullable().optional(), summaryStatus: z.enum(['missing', 'ready', 'pending', 'review-required']).optional(),
  summaryGeneration: z.number().int().nonnegative().optional(),
})
export type LibraryOrganization = z.infer<typeof libraryOrganizationSchema>
export const registryOrganizationSchema = z.strictObject({
  groups: z.array(z.strictObject({ id: identifier, name: z.string().trim().min(1).max(80), order: z.number().int().nonnegative() })).optional(),
  discovery: z.strictObject({ pinnedLimit: z.number().int().min(0).max(20).default(5) }).optional(),
})
export type RegistryOrganization = z.infer<typeof registryOrganizationSchema>
