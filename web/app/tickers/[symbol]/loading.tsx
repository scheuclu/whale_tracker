import { TickerLoading } from "../loading";

/** One ticker's page while it renders: the same skeleton `/tickers` shows
 *  when it is loading a ticker. */
export default function Loading() {
  return <TickerLoading />;
}
