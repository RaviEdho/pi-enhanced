/** Pi's offline mode disables automatic discovery and quota polling, not explicit inference. */
export function isProviderNetworkEnabled(): boolean {
  return process.env.PI_OFFLINE === undefined && !process.argv.includes("--offline");
}
