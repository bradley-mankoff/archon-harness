import { z } from "zod";
import { modelSelectionSchema } from "./model.ts";

export const harnessProfileSchema = z.enum(["omp-native", "pi-modular"]);
export type HarnessProfile = z.infer<typeof harnessProfileSchema>;

export const managedProfilesSchema = z.object({
  defaultProfile: harnessProfileSchema.default("omp-native"),
  profiles: z.object({
    "omp-native": modelSelectionSchema,
    "pi-modular": modelSelectionSchema.optional(),
  }),
});

export type ManagedProfiles = z.infer<typeof managedProfilesSchema>;

export const profileWorkflow: Record<HarnessProfile, string> = {
  "omp-native": "archon-efficient-omp",
  "pi-modular": "archon-efficient-pi",
};

export const profileModelEnvironment: Record<HarnessProfile, { model: string; thinking: string }> =
  {
    "omp-native": {
      model: "HARNESS_OMP_PROFILE_MODEL",
      thinking: "HARNESS_OMP_PROFILE_THINKING",
    },
    "pi-modular": {
      model: "HARNESS_PI_PROFILE_MODEL",
      thinking: "HARNESS_PI_PROFILE_THINKING",
    },
  };
