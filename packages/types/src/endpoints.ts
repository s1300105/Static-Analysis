/**
 * E1（隠しエンドポイント・パラメータ）の型（design.md §6.2）。
 */
import type { ParamLocation } from './vocab';

/** endpoint_sighting.params の要素。値は持たない（名前と置き場所だけ） */
export interface EndpointParam {
  name: string;
  in: ParamLocation;
}
