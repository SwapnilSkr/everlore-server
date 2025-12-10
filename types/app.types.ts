import { ApiRouteConfig, EventConfig, CronConfig } from "motia";
import type { Emit } from "motia";

type Optional<T, K extends keyof T> = Omit<T, K> & Pick<Partial<T>, K>;

export type TypedApiRouteConfig = Optional<ApiRouteConfig, "emits">;

export type TypedEventConfig = Optional<EventConfig, "emits">;

export type TypedCronConfig = Optional<CronConfig, "emits">;

export function normalizeConfig(
  config: TypedApiRouteConfig | TypedEventConfig | TypedCronConfig
): ApiRouteConfig | EventConfig | CronConfig {
  return {
    ...config,
    emits: config.emits || ([] as Emit[]),
  } as ApiRouteConfig | EventConfig | CronConfig;
}
