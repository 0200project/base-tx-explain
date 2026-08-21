/*
 * x402 payment from a browser wallet. No dependencies, no build step.
 *
 * Until now a human could watch the paywall work and do nothing about it: the
 * playground told them "a browser stops here; an agent pays $0.02 and keeps
 * going", which was true only because nobody had written this file. Paying
 * needs an EIP-3009 authorization signed by the payer's own wallet, and that
 * signature can only come from the browser.
 *
 * WHAT THIS DOES NOT DO, deliberately:
 *  - It never sees, holds or asks for a private key. The wallet signs; we relay.
 *  - It never moves funds itself. An EIP-3009 authorization is a signed message,
 *    not a transaction; the facilitator submits it and pays the gas.
 *  - It never invents any payment parameter. Amount, recipient, token, chain and
 *    the EIP-712 domain all come from the server's own 402 challenge, and every
 *    one of them is checked against that challenge before anything is signed.
 *
 * The last point is the reason this is hand-written rather than a vendored
 * library. A third-party script on a payment page is the one place where a
 * silent dependency update can redirect a signed payment, and the rest of this
 * site is dependency-free vanilla JS with no bundler. The usual argument for a
 * library is that hand-rolling EIP-712 invites subtle bugs, which is fair in
 * general and weak here: the challenge carries the domain in `extra`, so the
 * only fixed constant below is the EIP-3009 struct definition from the spec.
 * Nothing is guessed.
 */
(function () {
  'use strict';

  var BASE_CHAIN_ID = 8453;
  var BASE_CHAIN_HEX = '0x2105';

  // EIP-3009. Field order is consensus-critical: it determines the type hash,
  // so a reordering here produces a valid-looking signature the token contract
  // will reject. Do not "tidy" this.
  var TRANSFER_WITH_AUTHORIZATION_TYPE = [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ];

  var EIP712_DOMAIN_TYPE = [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ];

  /**
   * Errors carry a stable `code` so the page can render an honest state for
   * each one. Wallet flows fail in ways HTTP does not -- the person declines,
   * the wallet is on another chain, the account is empty -- and collapsing
   * those into one "payment failed" would be both unhelpful and untrue.
   */
  function PayError(code, message, detail) {
    var e = new Error(message);
    e.code = code;
    if (detail) e.detail = detail;
    return e;
  }

  function provider() {
    return typeof window !== 'undefined' && window.ethereum ? window.ethereum : null;
  }

  /** Is there any injected wallet at all? The page should ask before offering to pay. */
  function available() {
    return provider() !== null;
  }

  function request(method, params) {
    var p = provider();
    if (!p) return Promise.reject(PayError('NO_WALLET', 'No browser wallet is installed.'));
    return p.request({ method: method, params: params || [] });
  }

  // EIP-1193: 4001 is the standard "user rejected request" code. Wallets vary in
  // the message but are consistent on the code, so branch on the code.
  function isRejection(err) {
    return Boolean(err) && (err.code === 4001 || err.code === 'ACTION_REJECTED');
  }

  function toHexAmount(decimalString) {
    return '0x' + BigInt(decimalString).toString(16);
  }

  function randomNonce() {
    var bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    var out = '0x';
    for (var i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
    return out;
  }

  /**
   * Pull the one payment option we can actually satisfy out of the challenge.
   *
   * The server may offer several. We only handle `exact` on Base, and we would
   * rather say so than sign against terms we did not understand.
   */
  function selectAccepts(challenge) {
    var list = (challenge && challenge.accepts) || [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (a.scheme === 'exact' && a.network === 'eip155:' + BASE_CHAIN_ID) return a;
    }
    throw PayError(
      'UNSUPPORTED',
      'This payment request is not one this page knows how to pay (it needs the "exact" scheme on Base).',
    );
  }

  /**
   * Refuse to sign a malformed or surprising challenge.
   *
   * The wallet shows the payer what they are signing and is the real backstop,
   * but a person reading a hex string in a confirmation dialog is a weak last
   * line. Anything structurally wrong should be caught before a signature is
   * ever requested, not explained afterwards.
   */
  function validateAccepts(a) {
    var addr = /^0x[0-9a-fA-F]{40}$/;
    if (!addr.test(a.asset || '')) throw PayError('BAD_CHALLENGE', 'The payment request names an invalid token address.');
    if (!addr.test(a.payTo || '')) throw PayError('BAD_CHALLENGE', 'The payment request names an invalid recipient.');
    var value;
    try {
      value = BigInt(a.amount);
    } catch (e) {
      throw PayError('BAD_CHALLENGE', 'The payment request names an unreadable amount.');
    }
    if (value <= 0n) throw PayError('BAD_CHALLENGE', 'The payment request asks for a non-positive amount.');
    if (!a.extra || typeof a.extra.name !== 'string' || typeof a.extra.version !== 'string') {
      // Without these the EIP-712 domain would have to be guessed, and a wrong
      // domain yields a signature the token silently rejects at settlement.
      throw PayError('BAD_CHALLENGE', 'The payment request is missing the token signing domain.');
    }
    return value;
  }

  function connect() {
    return request('eth_requestAccounts').then(function (accounts) {
      if (!accounts || !accounts.length) throw PayError('NO_ACCOUNT', 'The wallet did not return an account.');
      return accounts[0];
    });
  }

  /**
   * Make sure the wallet is on Base before signing.
   *
   * The EIP-712 domain pins chainId 8453, so a signature produced while the
   * wallet is on another chain is simply invalid. Catching it here means the
   * person gets "switch to Base" rather than an opaque settlement failure after
   * they have already approved something.
   */
  function ensureBase() {
    return request('eth_chainId').then(function (id) {
      if (parseInt(id, 16) === BASE_CHAIN_ID) return true;
      return request('wallet_switchEthereumChain', [{ chainId: BASE_CHAIN_HEX }])
        .then(function () {
          return true;
        })
        .catch(function (err) {
          if (isRejection(err)) {
            throw PayError('WRONG_NETWORK', 'Payment needs the wallet on Base. The network switch was declined.');
          }
          // 4902: chain unknown to the wallet. Offer to add it rather than dead-end.
          if (err && err.code === 4902) {
            return request('wallet_addEthereumChain', [
              {
                chainId: BASE_CHAIN_HEX,
                chainName: 'Base',
                nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
                rpcUrls: ['https://mainnet.base.org'],
                blockExplorerUrls: ['https://basescan.org'],
              },
            ]).then(function () {
              return true;
            });
          }
          throw PayError('WRONG_NETWORK', 'The wallet could not switch to Base.');
        });
    });
  }

  /**
   * Read the payer's token balance before asking for a signature.
   *
   * A connected wallet holding no USDC is a real and probably common case: the
   * person has a wallet because they are a developer, not because they hold
   * stablecoins on Base. Signing anyway would produce an authorization that
   * fails at settlement and look like our bug. Better to say plainly what is
   * missing while they can still do something about it.
   */
  function balanceOf(asset, owner) {
    var data = '0x70a08231' + owner.slice(2).toLowerCase().padStart(64, '0');
    return request('eth_call', [{ to: asset, data: data }, 'latest']).then(function (hex) {
      if (!hex || hex === '0x') return 0n;
      return BigInt(hex);
    });
  }

  function buildTypedData(a, from, validBefore, nonce) {
    return {
      types: {
        EIP712Domain: EIP712_DOMAIN_TYPE,
        TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPE,
      },
      primaryType: 'TransferWithAuthorization',
      domain: {
        name: a.extra.name,
        version: a.extra.version,
        chainId: BASE_CHAIN_ID,
        verifyingContract: a.asset,
      },
      message: {
        from: from,
        to: a.payTo,
        value: String(a.amount),
        validAfter: '0',
        validBefore: String(validBefore),
        nonce: nonce,
      },
    };
  }

  /** Atomic units to a human string, e.g. 20000 -> "0.02" at 6 decimals. */
  function formatUnits(raw, decimals) {
    var s = BigInt(raw).toString().padStart(decimals + 1, '0');
    var whole = s.slice(0, s.length - decimals);
    var frac = s.slice(s.length - decimals).replace(/0+$/, '');
    return frac ? whole + '.' + frac : whole;
  }

  /**
   * Connect and report whether this wallet could actually pay, without signing.
   *
   * Exists because EIP-3009 will happily sign an authorization for money the
   * payer does not have: the shortfall only surfaces later, at settlement, by
   * which point the person has approved something that was never going to
   * work and it looks like our failure. So the page can call this first and
   * decline to offer a payment it knows cannot succeed, rather than inviting a
   * signature into a dead end.
   *
   * Reports balance either way, so an empty wallet can be told what it holds
   * and what is needed instead of a generic insufficient-funds message.
   */
  function inspect(challenge) {
    var accepts, required, from;
    return Promise.resolve()
      .then(function () {
        if (!available()) throw PayError('NO_WALLET', 'No browser wallet is installed.');
        accepts = selectAccepts(challenge);
        required = validateAccepts(accepts);
        return connect();
      })
      .then(function (account) {
        from = account;
        return ensureBase();
      })
      .then(function () {
        return balanceOf(accepts.asset, from);
      })
      .then(function (held) {
        var decimals = 6; // USDC
        return {
          account: from,
          canPay: held >= required,
          held: held.toString(),
          heldDisplay: formatUnits(held, decimals),
          required: required.toString(),
          requiredDisplay: formatUnits(required, decimals),
          asset: accepts.asset,
        };
      })
      .catch(function (err) {
        if (isRejection(err)) throw PayError('REJECTED', 'Connecting the wallet was declined.');
        if (err && err.code) throw err;
        throw PayError('FAILED', (err && err.message) || 'The wallet could not be inspected.');
      });
  }

  /**
   * Connect, verify, sign, and return the payment payload to attach to a retry.
   *
   * Returns the object that belongs at `_meta["x402/payment"]` on the retried
   * MCP call. It does NOT retry for you: the caller owns the request it is
   * paying for, and re-issuing it here would mean this module deciding when
   * money buys what.
   *
   * `onState` reports progress so the page can show which step is happening.
   * Every step involves either a wallet dialog or a network read, so a single
   * spinner would leave the person unsure whether anything is waiting on them.
   */
  function payChallenge(challenge, options) {
    var opts = options || {};
    var notify = typeof opts.onState === 'function' ? opts.onState : function () {};
    var accepts, required, from;

    return Promise.resolve()
      .then(function () {
        if (!available()) {
          throw PayError('NO_WALLET', 'No browser wallet is installed.');
        }
        accepts = selectAccepts(challenge);
        required = validateAccepts(accepts);
        notify('connecting');
        return connect();
      })
      .then(function (account) {
        from = account;
        notify('network');
        return ensureBase();
      })
      .then(function () {
        notify('balance');
        return balanceOf(accepts.asset, from);
      })
      .then(function (held) {
        if (held < required) {
          throw PayError('INSUFFICIENT_FUNDS', 'This wallet does not hold enough USDC on Base to pay.', {
            held: held.toString(),
            required: required.toString(),
            asset: accepts.asset,
            account: from,
          });
        }
        // The authorization is only valid for a window, and the server states
        // how long it needs to settle. Too short and a slow facilitator turns a
        // good payment into a failed one after the person already approved it.
        var timeout = Number(accepts.maxTimeoutSeconds) || 300;
        var validBefore = Math.floor(Date.now() / 1000) + Math.max(timeout, 120);
        var typedData = buildTypedData(accepts, from, validBefore, randomNonce());
        notify('signing');
        return request('eth_signTypedData_v4', [from, JSON.stringify(typedData)]).then(function (signature) {
          return { typedData: typedData, signature: signature };
        });
      })
      .then(function (signed) {
        notify('signed');
        return {
          payer: from,
          payment: {
            x402Version: challenge.x402Version || 2,
            accepted: accepts,
            payload: {
              signature: signed.signature,
              authorization: signed.typedData.message,
            },
          },
        };
      })
      .catch(function (err) {
        if (isRejection(err)) {
          // Declining is a choice, not a failure. The page should say nothing
          // was charged rather than present this as an error.
          throw PayError('REJECTED', 'The payment signature was declined. Nothing was charged.');
        }
        if (err && err.code) throw err;
        throw PayError('FAILED', (err && err.message) || 'The payment could not be prepared.');
      });
  }

  /**
   * Pull the x402 challenge out of an MCP tool result.
   *
   * The 402 arrives as JSON inside the tool result text rather than as an HTTP
   * status, because the MCP call itself succeeded -- it is the tool that is
   * telling you it needs paying.
   */
  function challengeFrom(mcpResult) {
    try {
      var content = mcpResult && mcpResult.result && mcpResult.result.content;
      if (!content || !content.length) return null;
      var parsed = JSON.parse(content[0].text);
      return parsed && parsed.accepts && parsed.x402Version ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  window.x402Pay = {
    available: available,
    challengeFrom: challengeFrom,
    inspect: inspect,
    payChallenge: payChallenge,
    formatUnits: formatUnits,
    BASE_CHAIN_ID: BASE_CHAIN_ID,
  };
})();
