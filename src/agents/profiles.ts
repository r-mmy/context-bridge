import { z } from "zod";

export const PROFILE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const ProfileNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(PROFILE_NAME_PATTERN);

// Persisted profile fields use bounded identifier syntax. The CLI also asks
// the local App Server to validate a profile's model and reasoning effort.
export const AgentProfileSchema = z
  .object({
    model_id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
    reasoning_effort: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z][a-z0-9-]*$/),
  })
  .strict();

export const AgentProfilesSchema = z.record(
  ProfileNameSchema,
  AgentProfileSchema,
);

export type AgentProfile = z.infer<typeof AgentProfileSchema>;
export type AgentProfiles = z.infer<typeof AgentProfilesSchema>;

export const DEFAULT_PROFILE_NAME = "luna-max";
export const DEFAULT_AGENT_PROFILE: AgentProfile = {
  model_id: "gpt-6-luna",
  reasoning_effort: "max",
};
