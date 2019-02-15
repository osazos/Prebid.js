import * as utils from '../src/utils';
import {registerBidder} from '../src/adapters/bidderFactory';
const BIDDER_CODE = 'trustx';
const ENDPOINT_URL = '//sofia.trustx.org/hb';
const TIME_TO_LIVE = 360;
const ADAPTER_SYNC_URL = '//sofia.trustx.org/push_sync';
const LOG_ERROR_MESS = {
  noAuid: 'Bid from response has no auid parameter - ',
  noAdm: 'Bid from response has no adm parameter - ',
  noBid: 'Array of bid objects is empty',
  noPlacementCode: 'Can\'t find in requested bids the bid with auid - ',
  emptyUids: 'Uids should be not empty',
  emptySeatbid: 'Seatbid array from response has empty item',
  emptyResponse: 'Response is empty',
  hasEmptySeatbidArray: 'Response has empty seatbid array',
  hasNoArrayOfBids: 'Seatbid from response has no array of bid objects - '
};
export const spec = {
  code: BIDDER_CODE,
  /**
   * Determines whether or not the given bid request is valid.
   *
   * @param {BidRequest} bid The bid params to validate.
   * @return boolean True if this is a valid bid, and false otherwise.
   */
  isBidRequestValid: function(bid) {
    return !!bid.params.uid;
  },
  /**
   * Make a server request from the list of BidRequests.
   *
   * @param {BidRequest[]} validBidRequests - an array of bids
   * @param {bidderRequest} - bidder request object
   * @return ServerRequest Info describing the request to the server.
   */
  buildRequests: function(validBidRequests, bidderRequest) {
    const auids = [];
    const bidsMap = {};
    const slotsMapByUid = {};
    const sizeMap = {};
    const bids = validBidRequests || [];
    let priceType = 'net';
    let reqId;

    bids.forEach(bid => {
      if (bid.params.priceType === 'gross') {
        priceType = 'gross';
      }
      reqId = bid.bidderRequestId;
      const {params: {uid}, adUnitCode} = bid;
      auids.push(uid);
      const sizesId = utils.parseSizesInput(bid.sizes);

      if (!slotsMapByUid[uid]) {
        slotsMapByUid[uid] = {};
      }
      const slotsMap = slotsMapByUid[uid];
      if (!slotsMap[adUnitCode]) {
        slotsMap[adUnitCode] = {adUnitCode, bids: [bid], parents: []};
      } else {
        slotsMap[adUnitCode].bids.push(bid);
      }
      const slot = slotsMap[adUnitCode];

      sizesId.forEach((sizeId) => {
        sizeMap[sizeId] = true;
        if (!bidsMap[uid]) {
          bidsMap[uid] = {};
        }

        if (!bidsMap[uid][sizeId]) {
          bidsMap[uid][sizeId] = [slot];
        } else {
          bidsMap[uid][sizeId].push(slot);
        }
        slot.parents.push({parent: bidsMap[uid], key: sizeId, uid});
      });
    });

    const payload = {
      u: utils.getTopWindowUrl(),
      pt: priceType,
      auids: auids.join(','),
      sizes: utils.getKeys(sizeMap).join(','),
      r: reqId
    };

    if (bidderRequest) {
      if (bidderRequest.timeout) {
        payload.wtimeout = bidderRequest.timeout;
      }
      if (bidderRequest.gdprConsent) {
        if (bidderRequest.gdprConsent.consentString) {
          payload.gdpr_consent = bidderRequest.gdprConsent.consentString;
        }
        payload.gdpr_applies =
          (typeof bidderRequest.gdprConsent.gdprApplies === 'boolean')
            ? Number(bidderRequest.gdprConsent.gdprApplies) : 1;
      }
    }

    return {
      method: 'GET',
      url: ENDPOINT_URL,
      data: utils.parseQueryStringParameters(payload).replace(/\&$/, ''),
      bidsMap: bidsMap,
    };
  },
  /**
   * Unpack the response from the server into a list of bids.
   *
   * @param {*} serverResponse A successful response from the server.
   * @param {*} bidRequest
   * @return {Bid[]} An array of bids which were nested inside the server.
   */
  interpretResponse: function(serverResponse, bidRequest) {
    serverResponse = serverResponse && serverResponse.body;
    const bidResponses = [];
    const remainingServerBids = [];
    const bidsMap = bidRequest.bidsMap;
    const priceType = bidRequest.data.pt;

    let errorMessage;

    if (!serverResponse) errorMessage = LOG_ERROR_MESS.emptyResponse;
    else if (serverResponse.seatbid && !serverResponse.seatbid.length) {
      errorMessage = LOG_ERROR_MESS.hasEmptySeatbidArray;
    }

    if (!errorMessage && serverResponse.seatbid) {
      serverResponse.seatbid.forEach(respItem => {
        _addBidResponse(_getBidFromResponse(respItem), bidsMap, priceType, bidResponses, remainingServerBids);
      });
    }
    if (remainingServerBids.length) {
      remainingServerBids.forEach(serverBid => {
        _addBidResponse(serverBid, bidsMap, priceType, bidResponses);
      });
    }
    if (errorMessage) utils.logError(errorMessage);
    return bidResponses;
  },
  getUserSyncs: function(syncOptions) {
    if (syncOptions.pixelEnabled) {
      return [{
        type: 'image',
        url: ADAPTER_SYNC_URL
      }];
    }
  }
}

function _getBidFromResponse(respItem) {
  if (!respItem) {
    utils.logError(LOG_ERROR_MESS.emptySeatbid);
  } else if (!respItem.bid) {
    utils.logError(LOG_ERROR_MESS.hasNoArrayOfBids + JSON.stringify(respItem));
  } else if (!respItem.bid[0]) {
    utils.logError(LOG_ERROR_MESS.noBid);
  }
  return respItem && respItem.bid && respItem.bid[0];
}

function _addBidResponse(serverBid, bidsMap, priceType, bidResponses, remainingServerBids) {
  if (!serverBid) return;
  let errorMessage;
  if (!serverBid.auid) errorMessage = LOG_ERROR_MESS.noAuid + JSON.stringify(serverBid);
  if (!serverBid.adm) errorMessage = LOG_ERROR_MESS.noAdm + JSON.stringify(serverBid);
  else {
    const ignoreSizes = !remainingServerBids;
    const awaitingBids = bidsMap[serverBid.auid];
    if (awaitingBids) {
      let sizeId = `${serverBid.w}x${serverBid.h}`;

      if (!awaitingBids[sizeId]) {
        if (ignoreSizes) {
          sizeId = utils.getKeys(awaitingBids)[0];
        } else {
          remainingServerBids.push(serverBid);
          return;
        }
      }

      const slot = awaitingBids[sizeId][0];

      const bid = slot.bids.shift();
      bidResponses.push({
        requestId: bid.bidId, // bid.bidderRequestId,
        bidderCode: spec.code,
        cpm: serverBid.price,
        width: serverBid.w,
        height: serverBid.h,
        creativeId: serverBid.auid, // bid.bidId,
        currency: 'USD',
        netRevenue: priceType !== 'gross',
        ttl: TIME_TO_LIVE,
        ad: serverBid.adm,
        dealId: serverBid.dealid
      });

      if (!slot.bids.length) {
        slot.parents.forEach(({parent, key, uid}) => {
          const index = parent[key].indexOf(slot);
          if (index > -1) {
            parent[key].splice(index, 1);
          }
          if (!parent[key].length) {
            delete parent[key];
            if (!utils.getKeys(parent).length) {
              delete bidsMap[uid];
            }
          }
        });
      }
    } else {
      errorMessage = LOG_ERROR_MESS.noPlacementCode + serverBid.auid;
    }
  }
  if (errorMessage) {
    utils.logError(errorMessage);
  }
}

registerBidder(spec);
