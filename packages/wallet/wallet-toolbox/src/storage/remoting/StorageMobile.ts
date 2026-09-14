import { WalletInterface } from '@bsv/sdk'
import { StorageClientBase, type StorageClientOptions } from './StorageClientBase'

/**
 * `StorageClient` (mobile variant) implements the `WalletStorageProvider` interface which allows it to
 * serve as a BRC-100 wallet's active storage.
 *
 * Internally, it uses JSON-RPC over HTTPS to make requests of a remote server.
 * Typically this server uses the `StorageServer` class to implement the service.
 *
 * This mobile variant omits the full logger support present in `StorageClient` to keep
 * the bundle lean for mobile / browser environments.
 *
 * For details of the API implemented, follow the "See also" link for the `WalletStorageProvider` interface.
 */
export class StorageClient extends StorageClientBase {
  constructor(wallet: WalletInterface, endpointUrl: string, options: StorageClientOptions = {}) {
    super(wallet, endpointUrl, options)
  }

  /// ///////////////////////////////////////////////////////////////////////////
  // JSON-RPC helper
  /// ///////////////////////////////////////////////////////////////////////////

  /**
   * Make a JSON-RPC call to the remote server.
   * @param method The WalletStorage method name to call.
   * @param params The array of parameters to pass to the method in order.
   */
  protected async rpcCall<T>(method: string, params: unknown[]): Promise<T> {
    return await this.traceRpcCall(method, params, async rpcSpan => {
      const { response, json, encoding } = await this.exchangeRpc(method, params, rpcSpan)
      if (json.error) {
        const { code, message, data } = json.error
        const err = new Error(`RPC Error: ${message}`)
        // You could attach more info here if you like:
        ;(err as any).code = code
        ;(err as any).data = data
        throw err
      }

      rpcSpan?.end({
        attributes: {
          'http.response.status_code': response.status,
          'rpc.encoding': encoding
        }
      })
      return json.result
    })
  }
}
