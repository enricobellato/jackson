import saml from '@boxyhq/saml20';
import crypto from 'crypto';
import { promisify } from 'util';
import { deflateRaw } from 'zlib';
import type { SAMLProfile } from '@boxyhq/saml20/dist/typings';
import { generators } from 'openid-client';

import type { JacksonOption, Storable, SAMLSSORecord, OIDCSSORecord } from '../typings';
import { getDefaultCertificate } from '../saml/x509';
import * as dbutils from '../db/utils';
import { JacksonError } from './error';
import { IndexNames } from './utils';
import { relayStatePrefix } from './utils';
import { createSAMLResponse } from '../saml/lib';
import * as redirect from './oauth/redirect';
import { oidcIssuerInstance } from './oauth/oidc-issuer';

const deflateRawAsync = promisify(deflateRaw);

export class SSOHandler {
  private connection: Storable;
  private session: Storable;
  private opts: JacksonOption;

  constructor({
    connection,
    session,
    opts,
  }: {
    connection: Storable;
    session: Storable;
    opts: JacksonOption;
  }) {
    this.connection = connection;
    this.session = session;
    this.opts = opts;
  }

  // If there are multiple connections for the given tenant and product, return the url to the IdP selection page
  // If idp_hint is provided, return the connection with the matching clientID
  // If there is only one connection, return the connection
  async resolveConnection(params: {
    authFlow: 'oauth' | 'saml' | 'idp-initiated';
    originalParams: Record<string, string>;
    tenant?: string;
    product?: string;
    entityId?: string;
    idp_hint?: string;
    samlFedAppId?: string;
  }): Promise<
    | {
        connection: SAMLSSORecord | OIDCSSORecord;
      }
    | {
        redirectUrl: string;
      }
    | {
        postForm: string;
      }
  > {
    const { authFlow, originalParams, tenant, product, idp_hint, entityId, samlFedAppId = '' } = params;

    let connections: (SAMLSSORecord | OIDCSSORecord)[] | null = null;

    // Find SAML connections for the app
    if (tenant && product) {
      connections = (
        await this.connection.getByIndex({
          name: IndexNames.TenantProduct,
          value: dbutils.keyFromParts(tenant, product),
        })
      ).data;
    }

    if (entityId) {
      connections = (
        await this.connection.getByIndex({
          name: IndexNames.EntityID,
          value: entityId,
        })
      ).data;
    }

    const noSSOConnectionErrMessage = 'No SSO connection found.';

    if (!connections || connections.length === 0) {
      throw new JacksonError(noSSOConnectionErrMessage, 404);
    }

    // If an IdP is specified, find the connection for that IdP
    if (idp_hint) {
      const connection = connections.find((c) => c.clientID === idp_hint);

      if (!connection) {
        throw new JacksonError(noSSOConnectionErrMessage, 404);
      }

      return { connection };
    }

    // If more than one, redirect to the connection selection page
    if (connections.length > 1) {
      const url = new URL(`${this.opts.externalUrl}${this.opts.idpDiscoveryPath}`);

      // SP initiated flow
      if (['oauth', 'saml'].includes(authFlow) && tenant && product) {
        const params = new URLSearchParams({
          tenant,
          product,
          authFlow: 'sp-initiated',
          samlFedAppId,
          ...originalParams,
        });

        return { redirectUrl: `${url}?${params}` };
      }

      // IdP initiated flow
      if (authFlow === 'idp-initiated' && entityId) {
        const params = new URLSearchParams({
          entityId,
          authFlow,
        });

        const postForm = saml.createPostForm(`${this.opts.idpDiscoveryPath}?${params}`, [
          {
            name: 'SAMLResponse',
            value: originalParams.SAMLResponse,
          },
        ]);

        return { postForm };
      }
    }

    // If only one, use that connection
    return { connection: connections[0] };
  }

  async createSAMLRequest({
    connection,
    requestParams,
  }: {
    connection: SAMLSSORecord;
    requestParams: Record<string, any>;
  }) {
    // We have a connection now, so we can create the SAML request
    const certificate = await getDefaultCertificate();

    const { sso } = connection.idpMetadata;

    let ssoUrl;
    let post = false;

    if ('redirectUrl' in sso) {
      ssoUrl = sso.redirectUrl;
    } else if ('postUrl' in sso) {
      ssoUrl = sso.postUrl;
      post = true;
    }

    const samlRequest = saml.request({
      ssoUrl,
      entityID: `${this.opts.samlAudience}`,
      callbackUrl: this.opts.externalUrl + this.opts.samlPath,
      signingKey: certificate.privateKey,
      publicKey: certificate.publicKey,
      forceAuthn: !!connection.forceAuthn,
      identifierFormat: connection.identifierFormat
        ? connection.identifierFormat
        : 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    });

    const relayState = await this.createSession({
      requestId: samlRequest.id,
      requested: {
        ...requestParams,
        client_id: connection.clientID,
      },
    });

    let redirectUrl;
    let authorizeForm;

    // Decide whether to use HTTP Redirect or HTTP POST binding
    if (!post) {
      redirectUrl = redirect.success(ssoUrl, {
        RelayState: relayState,
        SAMLRequest: Buffer.from(await deflateRawAsync(samlRequest.request)).toString('base64'),
      });
    } else {
      authorizeForm = saml.createPostForm(ssoUrl, [
        {
          name: 'RelayState',
          value: relayState,
        },
        {
          name: 'SAMLRequest',
          value: Buffer.from(samlRequest.request).toString('base64'),
        },
      ]);
    }

    return {
      redirect_url: redirectUrl,
      authorize_form: authorizeForm,
    };
  }

  async createOIDCRequest({
    connection,
    requestParams,
  }: {
    connection: OIDCSSORecord;
    requestParams: Record<string, any>;
  }) {
    if (!this.opts.oidcPath) {
      throw new JacksonError('OpenID response handler path (oidcPath) is not set', 400);
    }

    const { discoveryUrl, metadata, clientId, clientSecret } = connection.oidcProvider;

    try {
      const oidcIssuer = await oidcIssuerInstance(discoveryUrl, metadata);
      const oidcClient = new oidcIssuer.Client({
        client_id: clientId!,
        client_secret: clientSecret,
        redirect_uris: [this.opts.externalUrl + this.opts.oidcPath],
        response_types: ['code'],
      });

      const oidcCodeVerifier = generators.codeVerifier();
      const code_challenge = generators.codeChallenge(oidcCodeVerifier);
      const oidcNonce = generators.nonce();

      const relayState = await this.createSession({
        requestId: connection.clientID,
        requested: requestParams,
        oidcCodeVerifier,
        oidcNonce,
      });

      const ssoUrl = oidcClient.authorizationUrl({
        scope: 'openid email profile',
        code_challenge,
        code_challenge_method: 'S256',
        state: relayState,
        nonce: oidcNonce,
      });

      return {
        redirect_url: ssoUrl,
      };
    } catch (err: any) {
      console.error(err);
      throw new JacksonError(`Unable to complete OIDC request. - ${err.message}`, 400);
    }
  }

  createSAMLResponse = async ({ profile, session }: { profile: SAMLProfile; session: any }) => {
    const certificate = await getDefaultCertificate();

    try {
      const responseSigned = await createSAMLResponse({
        audience: session.requested.entityId,
        acsUrl: session.requested.acsUrl,
        requestId: session.requested.id,
        issuer: `${this.opts.samlAudience}`,
        profile,
        ...certificate,
      });

      const responseForm = saml.createPostForm(session.requested.acsUrl, [
        {
          name: 'RelayState',
          value: session.requested.relayState,
        },
        {
          name: 'SAMLResponse',
          value: Buffer.from(responseSigned).toString('base64'),
        },
      ]);

      return { responseForm };
    } catch (err) {
      // TODO: Instead send saml response with status code
      throw new JacksonError('Unable to validate SAML Response.', 403);
    }
  };

  // Create a new session to store SP request information
  private createSession = async ({
    requestId,
    requested,
    oidcCodeVerifier,
    oidcNonce,
  }: {
    requestId: string;
    requested: any;
    oidcCodeVerifier?: string;
    oidcNonce?: string;
  }) => {
    const sessionId = crypto.randomBytes(16).toString('hex');

    const session = {
      id: requestId,
      requested,
      samlFederated: true,
    };

    if (oidcCodeVerifier) {
      session['oidcCodeVerifier'] = oidcCodeVerifier;
    }

    if (oidcNonce) {
      session['oidcNonce'] = oidcNonce;
    }

    await this.session.put(sessionId, session);

    return `${relayStatePrefix}${sessionId}`;
  };
}
