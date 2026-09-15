import { autoloadEnvironmentFiles } from "./env-file.js";

autoloadEnvironmentFiles();

export {
  assertRequiredEnv,
  collectEnvProblems,
  OPTIONAL_FEATURE_ENV,
  REQUIRED_ENV,
  SERVER_REQUIRED_ENV,
  warnMissingOptionalEnv,
} from "./env-validation.js";
export type { EnvRequirement } from "./env-validation.js";
