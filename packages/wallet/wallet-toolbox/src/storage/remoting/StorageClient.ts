import { WalletInterface, WalletLoggerInterface } from '@bsv/sdk'
import { WalletErrorFromJson } from '../../sdk/WalletErrorFromJson'
import { logWalletError } from '../../WalletLogger'
import { StorageClientBase, type StorageClientOptions } from './StorageClientBase'

interface RpcLoggerState {
  logger?: WalletLoggerInterface
  requestOptions?: Record<string, unknown>
}

/**
 * `StorageClient` implements the `WalletStorageProvider` interface which allows it to
 * serve as a BRC-100 wallet's active storage.
 *
 * Internally, it uses JSON-RPC over HTTPS to make requests of a remote server.
 * Typically this server uses the `StorageServer` class to implement the service.
 *
 * The `AuthFetch` component is used to secure and authenticate the requests to the remote server.
 *
 * `AuthFetch` is initialized with a BRC-100 wallet which establishes the identity of
 * the party making requests of the remote service.
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
      const loggerState = this.startRpcLogging(method, params)
      const { logger } = loggerState

      try {
        const { response, json, encoding } = await this.exchangeRpc(method, params, rpcSpan)
        if (json.error) {
          logWalletError(json.error, logger, 'error from remote service')
          const werr = WalletErrorFromJson(json.error)
          throw werr
        }

        if (logger != null) {
          // merge log data from request processing
          logger.merge?.(json.result?.log)
          logger.groupEnd()
        }

        rpcSpan?.end({
          attributes: {
            'http.response.status_code': response.status,
            'rpc.encoding': encoding
          }
        })
        return json.result
      } catch (error_: unknown) {
        logWalletError(error_, logger, 'error setting up request to remote service')
        throw error_
      } finally {
        this.restoreRpcLogging(loggerState)
      }
    })
  }

  private startRpcLogging(method: string, params: unknown[]): RpcLoggerState {
    const requestOptions =
      typeof params[1] === 'object' && params[1] !== null ? (params[1] as Record<string, unknown>) : undefined
    const logger = requestOptions?.logger as WalletLoggerInterface | undefined
    if (logger != null && requestOptions != null) {
      // Replace logger object with seed json object to continue logging on request server.
      logger.group(`StorageClient ${method}`)
      requestOptions.logger = { indent: logger.indent || 0 }
    }
    return { logger, requestOptions }
  }

  private restoreRpcLogging({ logger, requestOptions }: RpcLoggerState): void {
    if (logger != null && requestOptions != null) {
      // Restore original logger in params
      requestOptions.logger = logger
    }
  }
}
