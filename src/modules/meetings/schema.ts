import { z } from "zod";

export const meetingsInsertSchema = z.object({
    name: z.string().min(1, { message: "Name Is Required" }),
    agentId: z.string().min(1, { message: "Agent Is Required" }),
});

export const meetingsUpdateSchema = meetingsInsertSchema.extend({
    id: z.string().min(1, { message: "Id Is Required" }),
});