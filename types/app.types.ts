import { ApiRouteConfig, EventConfig, CronConfig } from "motia";

type RequiredFieldKeys = "name" | "type" | "description";

type WithOptionalEmits<T> = T extends { emits: infer E }
  ? Omit<T, "emits"> & { emits?: E }
  : T;
type RequiredFields<T, K extends keyof T> = T & {
  [P in K]-?: Exclude<T[P], undefined>;
};

export type TypedApiRouteConfig = RequiredFields<
  WithOptionalEmits<ApiRouteConfig>,
  RequiredFieldKeys
>;
export type TypedEventConfig = RequiredFields<
  WithOptionalEmits<EventConfig>,
  RequiredFieldKeys
>;
export type TypedCronConfig = RequiredFields<
  WithOptionalEmits<CronConfig>,
  RequiredFieldKeys
>;

export function normalizeConfig(
  config: TypedApiRouteConfig | TypedEventConfig | TypedCronConfig
): ApiRouteConfig | EventConfig | CronConfig {
  return {
    ...config,
    emits: config.emits ?? [],
  };
}
