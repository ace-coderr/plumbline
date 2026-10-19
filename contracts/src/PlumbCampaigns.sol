// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {PlumbQuote} from "./PlumbQuote.sol";
import {PlumbQuoteFactory} from "./PlumbQuoteFactory.sol";
import {IPlumbPenalizer} from "./interfaces/IPlumbPenalizer.sol";
import {IReferencePrice} from "./interfaces/IReferencePrice.sol";
import {PlumbScore} from "./libraries/PlumbScore.sol";

/// @title PlumbCampaigns
/// @notice Liquidity-uptime campaigns. A sponsor funds a reward pot for a pair and sets the quality
///         bar. Makers bond in with their PlumbQuote vaults. Anyone can probe a campaign: the probe
///         checks every bonded vault at that instant and gives a point to each one whose quote is
///         fresh, tight, deep, and actually backed by the inventory it advertises. Each epoch's pot is
///         split pro-rata by points.
/// @dev Probes are rate-limited by `minProbeInterval` plus a jitter gate that makers cannot see
///      coming (see `probeGateOpen`). All payouts (probe fees, rewards, released bonds, slash cuts)
///      are credited to `claimable` and withdrawn with `claim`.
contract PlumbCampaigns is IPlumbPenalizer, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /// @notice Terms a sponsor sets when opening a campaign.
    /// @param base Base token of the pair.
    /// @param quote Quote token of the pair.
    /// @param epochLength Seconds per reward epoch.
    /// @param rewardPerEpoch Reward paid out per epoch, in the campaign's reward token.
    /// @param maxSpreadBps Widest spread that still earns a point.
    /// @param minDepthBase Minimum ask size, raw base units.
    /// @param minDepthQuote Minimum bid notional, raw quote units.
    /// @param minProbeInterval Minimum seconds between probes, before jitter.
    /// @param probeFeeBps Fee per probe paid to the caller, in bps of `rewardPerEpoch`.
    /// @param makerBond Bond a maker posts per vault to be scored.
    struct Campaign {
        address base;
        address quote;
        uint64 epochLength;
        uint256 rewardPerEpoch;
        uint16 maxSpreadBps;
        uint256 minDepthBase;
        uint256 minDepthQuote;
        uint32 minProbeInterval;
        uint16 probeFeeBps;
        uint256 makerBond;
    }

    /// @notice Runtime state of a campaign.
    /// @param creator Sponsor; receives undistributed rewards.
    /// @param rewardToken ERC20 used for rewards and bonds, or address(0) for native HYPE.
    /// @param referencePrice Optional IReferencePrice source; address(0) scores spread around each quote's mid.
    /// @param startTime Start of epoch 0.
    /// @param numEpochs Number of funded epochs.
    /// @param settledEpochs Epochs [0, settledEpochs) have been settled.
    /// @param lastProbeAt Timestamp of the last probe.
    /// @param probeNonce Probes run so far.
    /// @param gateSeed Entropy for the probe gate, re-derived from prevrandao at every probe.
    struct State {
        address creator;
        address rewardToken;
        address referencePrice;
        uint64 startTime;
        uint32 numEpochs;
        uint32 settledEpochs;
        uint64 lastProbeAt;
        uint64 probeNonce;
        bytes32 gateSeed;
    }

    /// @notice A vault's bond in a campaign.
    /// @param maker Vault owner at registration.
    /// @param bond Bond currently held.
    /// @param unbondRequestedAt Zero while active; otherwise when the maker asked to leave.
    /// @param lastEpoch Last epoch the vault can have points in (set on unbond request).
    /// @param lastSlashedAt Timestamp of the most recent slash.
    struct Registration {
        address maker;
        uint128 bond;
        uint64 unbondRequestedAt;
        uint32 lastEpoch;
        uint64 lastSlashedAt;
    }

    /// @notice Per-epoch accounting.
    struct Epoch {
        uint32 probes;
        uint64 totalPoints;
        uint128 probeFeesPaid;
        uint128 slashBonus;
        bool settled;
    }

    /// @notice Maximum vaults bonded into one campaign at a time.
    uint256 public constant MAX_VAULTS = 32;
    /// @notice Maximum campaigns one vault can be bonded into.
    uint256 public constant MAX_CAMPAIGNS_PER_VAULT = 16;
    /// @notice Shortest allowed epoch.
    uint64 public constant MIN_EPOCH = 60;
    /// @notice Most epochs a campaign can fund.
    uint32 public constant MAX_EPOCHS = 10_000;
    /// @notice Share of an epoch pot that probe fees may ever consume.
    uint16 public constant MAX_PROBE_SHARE_BPS = 5_000;
    /// @notice Share of a bond removed per verified failed fill.
    uint16 public constant SLASH_BPS = 2_000;
    /// @notice Share of each slash paid to the reporter; the rest tops up the epoch pot.
    uint16 public constant REPORTER_BPS = 5_000;
    /// @notice How many recent block hashes can open the probe gate.
    uint256 public constant GATE_WINDOW = 8;
    /// @notice One in `GATE_ODDS` block hashes is a gate hit. Once `minProbeInterval` has passed, the
    ///         wait for the next hit is geometric with a mean of `GATE_ODDS` blocks: about 8s at
    ///         Elysium's ~120ms blocks. Being memoryless, the elapsed wait says nothing about when the
    ///         next probe will land.
    uint256 public constant GATE_ODDS = 64;
    /// @notice Oldest reference price the probe will use, in seconds.
    uint256 public constant MAX_REFERENCE_AGE = 60;

    /// @notice Vault registry used to authenticate vaults.
    PlumbQuoteFactory public immutable factory;
    /// @notice The only address allowed to report failed fills.
    address public immutable router;

    /// @notice Number of campaigns opened.
    uint256 public campaignCount;

    mapping(uint256 => Campaign) internal _terms;
    mapping(uint256 => State) internal _state;
    mapping(uint256 => address[]) internal _vaults;
    mapping(uint256 => mapping(address => Registration)) internal _regs;
    mapping(uint256 => mapping(uint256 => Epoch)) internal _epochs;
    mapping(uint256 => mapping(uint256 => mapping(address => uint64))) internal _points;
    mapping(address => uint256[]) internal _vaultCampaigns;

    /// @notice Pull-payment balances by token (address(0) is native HYPE) and account.
    mapping(address token => mapping(address account => uint256)) public claimable;

    /// @notice Emitted when a campaign is opened and funded.
    event CampaignOpened(
        uint256 indexed id,
        address indexed creator,
        address indexed base,
        address quote,
        address rewardToken,
        uint64 startTime,
        uint32 numEpochs,
        Campaign terms,
        address referencePrice
    );
    /// @notice Emitted when a vault bonds into a campaign.
    event MakerRegistered(uint256 indexed id, address indexed vault, address indexed maker, uint256 bond);
    /// @notice Emitted when a maker adds to a bond.
    event BondToppedUp(uint256 indexed id, address indexed vault, uint256 amount, uint256 bond);
    /// @notice Emitted when a maker starts unbonding.
    event UnbondRequested(uint256 indexed id, address indexed vault, uint64 releasableAt);
    /// @notice Emitted when a bond is released to the maker's claimable balance.
    event BondReleased(uint256 indexed id, address indexed vault, address indexed maker, uint256 amount);
    /// @notice Emitted once per probe.
    event Probed(
        uint256 indexed id,
        uint256 indexed epoch,
        address indexed prober,
        uint64 nonce,
        uint256 checked,
        uint256 passed,
        uint256 fee,
        uint256 referencePx
    );
    /// @notice Emitted for every vault a probe checks.
    /// @param failMask Bitwise OR of `PlumbScore.FAIL_*`; zero means a point was awarded.
    /// @param spreadBps Measured spread, saturated to uint32.
    event ProbeResult(
        uint256 indexed id,
        uint256 indexed epoch,
        address indexed vault,
        uint64 nonce,
        bool passed,
        uint16 failMask,
        uint32 spreadBps,
        uint128 bidPx,
        uint128 askPx,
        uint128 bidSize,
        uint128 askSize
    );
    /// @notice Emitted when a bond is slashed for a verified failed fill.
    event Penalized(
        uint256 indexed id,
        address indexed vault,
        address indexed reporter,
        uint256 slashed,
        uint256 toReporter,
        uint256 toMakers,
        uint64 pointsForfeited
    );
    /// @notice Emitted when an epoch's pot is split.
    event EpochSettled(
        uint256 indexed id,
        uint256 indexed epoch,
        uint256 makerPot,
        uint256 totalPoints,
        uint256 probes,
        uint256 refunded
    );
    /// @notice Emitted for each maker credited at settlement.
    event RewardCredited(
        uint256 indexed id,
        uint256 indexed epoch,
        address indexed vault,
        address maker,
        uint256 amount,
        uint256 points
    );
    /// @notice Emitted when an account withdraws its claimable balance.
    event Claimed(address indexed token, address indexed account, uint256 amount);

    error BadTerms();
    error BadFunding();
    error UnknownCampaign();
    error NotVault();
    error WrongPair();
    error NotMaker();
    error AlreadyRegistered();
    error NotRegistered();
    error CampaignFull();
    error VaultBusy();
    error CampaignOver();
    error NotActive();
    error GateClosed();
    error EpochNotOver();
    error NothingToSettle();
    error AlreadyUnbonding();
    error NotUnbonding();
    error StillBonded();
    error NotRouter();
    error NothingToClaim();
    error TransferFailed();

    /// @param factory_ Vault factory.
    /// @param router_ The PlumbRouter (deployed after this contract at a precomputed address).
    constructor(PlumbQuoteFactory factory_, address router_) {
        factory = factory_;
        router = router_;
    }

    // ---------------------------------------------------------------------------------------------
    // Sponsor
    // ---------------------------------------------------------------------------------------------

    /// @notice Open and fully fund a campaign. Funding is `rewardPerEpoch * numEpochs`.
    /// @param terms Campaign terms.
    /// @param rewardToken ERC20 for rewards and bonds, or address(0) for native HYPE (send as msg.value).
    /// @param numEpochs Number of epochs to fund.
    /// @param startTime Start of epoch 0; 0 or a past time means now.
    /// @param referencePrice Optional IReferencePrice; address(0) until HyperCore prices are on-chain.
    /// @return id New campaign id.
    function openCampaign(
        Campaign calldata terms,
        address rewardToken,
        uint32 numEpochs,
        uint64 startTime,
        address referencePrice
    ) external payable nonReentrant returns (uint256 id) {
        _validate(terms, numEpochs);
        uint64 start = startTime < block.timestamp ? block.timestamp.toUint64() : startTime;
        uint256 total = terms.rewardPerEpoch * numEpochs;

        id = ++campaignCount;
        _terms[id] = terms;
        _state[id] = State({
            creator: msg.sender,
            rewardToken: rewardToken,
            referencePrice: referencePrice,
            startTime: start,
            numEpochs: numEpochs,
            settledEpochs: 0,
            lastProbeAt: 0,
            probeNonce: 0,
            gateSeed: PlumbScore.nextGateSeed(bytes32(id), block.prevrandao, blockhash(block.number - 1))
        });

        _pullExact(rewardToken, total);
        emit CampaignOpened(id, msg.sender, terms.base, terms.quote, rewardToken, start, numEpochs, terms, referencePrice);
    }

    // ---------------------------------------------------------------------------------------------
    // Makers
    // ---------------------------------------------------------------------------------------------

    /// @notice Bond `vault` into campaign `id`. Caller must own the vault and send exactly `makerBond`
    ///         (as msg.value for native campaigns, or by approval for ERC20 campaigns).
    function register(uint256 id, address vault) external payable nonReentrant {
        Campaign storage t = _termsOf(id);
        State storage s = _state[id];
        if (!factory.isVault(vault)) revert NotVault();
        PlumbQuote v = PlumbQuote(vault);
        if (v.owner() != msg.sender) revert NotMaker();
        if (address(v.baseToken()) != t.base || address(v.quoteToken()) != t.quote) revert WrongPair();
        if (block.timestamp >= _endTime(s, t)) revert CampaignOver();
        if (_regs[id][vault].maker != address(0)) revert AlreadyRegistered();
        if (_vaults[id].length >= MAX_VAULTS) revert CampaignFull();
        if (_vaultCampaigns[vault].length >= MAX_CAMPAIGNS_PER_VAULT) revert VaultBusy();

        _regs[id][vault] = Registration({
            maker: msg.sender,
            bond: uint128(t.makerBond),
            unbondRequestedAt: 0,
            lastEpoch: 0,
            lastSlashedAt: 0
        });
        _vaults[id].push(vault);
        _vaultCampaigns[vault].push(id);

        _pullExact(s.rewardToken, t.makerBond);
        emit MakerRegistered(id, vault, msg.sender, t.makerBond);
    }

    /// @notice Add to a bond, e.g. to get back above `makerBond` after a slash.
    function topUpBond(uint256 id, address vault, uint256 amount) external payable nonReentrant {
        Registration storage r = _regs[id][vault];
        if (r.maker == address(0)) revert NotRegistered();
        if (r.maker != msg.sender) revert NotMaker();
        if (r.unbondRequestedAt != 0) revert AlreadyUnbonding();
        r.bond += amount.toUint128();
        _pullExact(_state[id].rewardToken, amount);
        emit BondToppedUp(id, vault, amount, r.bond);
    }

    /// @notice Stop being scored and start the unbonding clock (one epoch length). The bond stays
    ///         slashable until it is released.
    function requestUnbond(uint256 id, address vault) external {
        Campaign storage t = _termsOf(id);
        State storage s = _state[id];
        Registration storage r = _regs[id][vault];
        if (r.maker == address(0)) revert NotRegistered();
        if (r.maker != msg.sender) revert NotMaker();
        if (r.unbondRequestedAt != 0) revert AlreadyUnbonding();
        r.unbondRequestedAt = uint64(block.timestamp);
        uint256 e = _epochAt(s, t, block.timestamp);
        r.lastEpoch = (e < s.numEpochs ? e : s.numEpochs - 1).toUint32();
        emit UnbondRequested(id, vault, uint64(block.timestamp + t.epochLength));
    }

    /// @notice Release an unbonded bond to the maker's claimable balance. Requires the unbonding period
    ///         to have passed and every epoch the vault could have scored in to be settled.
    function releaseBond(uint256 id, address vault) external nonReentrant {
        Campaign storage t = _termsOf(id);
        State storage s = _state[id];
        Registration memory r = _regs[id][vault];
        if (r.maker == address(0)) revert NotRegistered();
        if (r.maker != msg.sender) revert NotMaker();
        if (r.unbondRequestedAt == 0) revert NotUnbonding();
        if (block.timestamp < r.unbondRequestedAt + t.epochLength) revert StillBonded();
        if (s.settledEpochs <= r.lastEpoch) revert StillBonded();

        delete _regs[id][vault];
        _removeVault(id, vault);
        claimable[s.rewardToken][r.maker] += r.bond;
        emit BondReleased(id, vault, r.maker, r.bond);
    }

    // ---------------------------------------------------------------------------------------------
    // Probing
    // ---------------------------------------------------------------------------------------------

    /// @notice Check every bonded vault right now and award a point to each that passes.
    /// @dev Reverts with `GateClosed` unless `probeGateOpen(id)`. The caller earns `probeFeeBps` of the
    ///      epoch pot (capped at `MAX_PROBE_SHARE_BPS` of the pot per epoch) when at least one vault
    ///      was checked.
    /// @return passed Number of vaults that earned a point.
    function probe(uint256 id) external nonReentrant returns (uint256 passed) {
        Campaign storage t = _termsOf(id);
        State storage s = _state[id];
        if (!probeGateOpen(id)) revert GateClosed();

        uint256 epoch = _epochAt(s, t, block.timestamp);
        uint64 nonce = s.probeNonce;
        s.lastProbeAt = uint64(block.timestamp);
        s.probeNonce = nonce + 1;
        s.gateSeed = PlumbScore.nextGateSeed(s.gateSeed, block.prevrandao, blockhash(block.number - 1));

        PlumbScore.Targets memory targets = PlumbScore.Targets(t.maxSpreadBps, t.minDepthBase, t.minDepthQuote);
        uint256 refPx = _referencePx(s, t);

        address[] storage vaults = _vaults[id];
        uint256 n = vaults.length;
        uint256 checked;
        for (uint256 i; i < n; ++i) {
            address vault = vaults[i];
            Registration storage r = _regs[id][vault];
            if (r.unbondRequestedAt != 0) continue;
            ++checked;
            bool pass = _scoreVault(id, epoch, nonce, vault, r.bond >= t.makerBond, targets, refPx);
            if (pass) ++passed;
        }

        Epoch storage e = _epochs[id][epoch];
        e.probes += 1;
        e.totalPoints += passed.toUint64();

        uint256 fee;
        if (checked > 0) {
            uint256 cap = t.rewardPerEpoch * MAX_PROBE_SHARE_BPS / PlumbScore.BPS;
            fee = PlumbScore.probeFee(t.rewardPerEpoch, t.probeFeeBps, e.probeFeesPaid, cap);
            if (fee > 0) {
                e.probeFeesPaid += fee.toUint128();
                claimable[s.rewardToken][msg.sender] += fee;
            }
        }
        emit Probed(id, epoch, msg.sender, nonce, checked, passed, fee, refPx);
    }

    /// @notice Whether `probe(id)` would be accepted in the current block.
    /// @dev Open when the campaign is running, `minProbeInterval` has passed since the last probe, and
    ///      at least one of the last `GATE_WINDOW` block hashes is a gate hit for the current probe
    ///      nonce. A hit keeps the gate open for `GATE_WINDOW` blocks, so a keeper that sees it can land
    ///      a transaction. A maker learns of an opening only when a keeper does, which is too late to
    ///      fake a quote and fund a vault ahead of the probe.
    function probeGateOpen(uint256 id) public view returns (bool) {
        Campaign storage t = _terms[id];
        State storage s = _state[id];
        if (t.epochLength == 0) return false;
        if (block.timestamp < s.startTime || block.timestamp >= _endTime(s, t)) return false;
        if (s.lastProbeAt != 0 && block.timestamp < uint256(s.lastProbeAt) + t.minProbeInterval) return false;
        uint256 limit = block.number < GATE_WINDOW ? block.number : GATE_WINDOW;
        bytes32 seed = s.gateSeed;
        uint64 nonce = s.probeNonce;
        for (uint256 k = 1; k <= limit; ++k) {
            if (PlumbScore.gateHit(blockhash(block.number - k), seed, id, nonce, GATE_ODDS)) {
                return true;
            }
        }
        return false;
    }

    // ---------------------------------------------------------------------------------------------
    // Settlement and penalties
    // ---------------------------------------------------------------------------------------------

    /// @notice Split the oldest finished, unsettled epoch's pot among makers by points. Anyone may call.
    /// @dev The maker pot is `rewardPerEpoch - probeFeesPaid + slashBonus`. Rounding dust, and the whole
    ///      pot when nobody scored, is credited back to the sponsor.
    /// @return epoch The epoch that was settled.
    function settle(uint256 id) external nonReentrant returns (uint256 epoch) {
        Campaign storage t = _termsOf(id);
        State storage s = _state[id];
        epoch = s.settledEpochs;
        if (epoch >= s.numEpochs) revert NothingToSettle();
        if (block.timestamp < uint256(s.startTime) + (epoch + 1) * t.epochLength) revert EpochNotOver();
        s.settledEpochs = (epoch + 1).toUint32();

        Epoch storage e = _epochs[id][epoch];
        e.settled = true;
        uint256 pot = t.rewardPerEpoch - e.probeFeesPaid + e.slashBonus;
        uint256 total = e.totalPoints;
        uint256 distributed;
        address token = s.rewardToken;

        if (total > 0) {
            address[] storage vaults = _vaults[id];
            uint256 n = vaults.length;
            for (uint256 i; i < n; ++i) {
                address vault = vaults[i];
                uint64 pts = _points[id][epoch][vault];
                if (pts == 0) continue;
                uint256 amount = PlumbScore.share(pot, pts, total);
                address maker = _regs[id][vault].maker;
                claimable[token][maker] += amount;
                distributed += amount;
                emit RewardCredited(id, epoch, vault, maker, amount, pts);
            }
        }
        uint256 refund = pot - distributed;
        if (refund > 0) claimable[token][s.creator] += refund;
        emit EpochSettled(id, epoch, pot, total, e.probes, refund);
    }

    /// @inheritdoc IPlumbPenalizer
    /// @dev Called by the router after it has confirmed the vault is short of the inventory its live
    ///      quote advertises. Slashes `SLASH_BPS` of every bond backing the vault, at most once per
    ///      `minProbeInterval` per campaign, and forfeits the vault's points for the current epoch.
    function penalize(address vault, address reporter) external {
        if (msg.sender != router) revert NotRouter();
        uint256[] storage ids = _vaultCampaigns[vault];
        uint256 n = ids.length;
        for (uint256 i; i < n; ++i) {
            _penalizeOne(ids[i], vault, reporter);
        }
    }

    /// @notice Withdraw the caller's claimable balance of `token` (address(0) for native HYPE).
    function claim(address token) external nonReentrant returns (uint256 amount) {
        amount = claimable[token][msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[token][msg.sender] = 0;
        _push(token, msg.sender, amount);
        emit Claimed(token, msg.sender, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice Campaign terms.
    function terms(uint256 id) external view returns (Campaign memory) {
        return _terms[id];
    }

    /// @notice Campaign runtime state.
    function state(uint256 id) external view returns (State memory) {
        return _state[id];
    }

    /// @notice Vaults currently bonded (including those unbonding).
    function vaultsOf(uint256 id) external view returns (address[] memory) {
        return _vaults[id];
    }

    /// @notice A vault's registration in a campaign.
    function registration(uint256 id, address vault) external view returns (Registration memory) {
        return _regs[id][vault];
    }

    /// @notice Campaigns a vault is bonded into.
    function campaignsOf(address vault) external view returns (uint256[] memory) {
        return _vaultCampaigns[vault];
    }

    /// @notice Epoch accounting.
    function epochInfo(uint256 id, uint256 epoch) external view returns (Epoch memory) {
        return _epochs[id][epoch];
    }

    /// @notice Points a vault holds in an epoch.
    function pointsOf(uint256 id, uint256 epoch, address vault) external view returns (uint64) {
        return _points[id][epoch][vault];
    }

    /// @notice Index of the epoch containing the current time (may be >= numEpochs once over).
    function currentEpoch(uint256 id) external view returns (uint256) {
        return _epochAt(_state[id], _terms[id], block.timestamp);
    }

    /// @notice Timestamp when the campaign's last epoch ends.
    function endTime(uint256 id) external view returns (uint256) {
        return _endTime(_state[id], _terms[id]);
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    function _scoreVault(
        uint256 id,
        uint256 epoch,
        uint64 nonce,
        address vault,
        bool bonded,
        PlumbScore.Targets memory targets,
        uint256 refPx
    ) internal returns (bool pass) {
        PlumbQuote v = PlumbQuote(vault);
        (PlumbQuote.Quote memory q, uint32 maxAge, uint256 freeBase, uint256 freeQuote) = v.probeSnapshot();
        PlumbScore.Observation memory o = PlumbScore.Observation({
            bidPx: q.bidPx,
            askPx: q.askPx,
            bidSize: q.bidSize,
            askSize: q.askSize,
            updatedAt: q.updatedAt,
            maxAge: maxAge,
            freeBase: freeBase,
            freeQuote: freeQuote,
            referencePx: refPx,
            baseUnit: v.baseUnit(),
            quoteUnit: v.quoteUnit()
        });
        (uint16 mask, uint256 spread) = PlumbScore.evaluate(targets, o, block.timestamp);
        if (!bonded) mask |= PlumbScore.FAIL_BOND;
        pass = mask == 0;
        if (pass) _points[id][epoch][vault] += 1;
        emit ProbeResult(
            id,
            epoch,
            vault,
            nonce,
            pass,
            mask,
            // forge-lint: disable-next-line(unsafe-typecast)
            spread > type(uint32).max ? type(uint32).max : uint32(spread),
            q.bidPx,
            q.askPx,
            q.bidSize,
            q.askSize
        );
    }

    function _penalizeOne(uint256 id, address vault, address reporter) internal {
        Registration storage r = _regs[id][vault];
        if (r.bond == 0) return;
        Campaign storage t = _terms[id];
        State storage s = _state[id];
        if (r.lastSlashedAt != 0 && block.timestamp < uint256(r.lastSlashedAt) + t.minProbeInterval) return;

        (uint256 slashed, uint256 toReporter, uint256 toMakers) =
            PlumbScore.slash(r.bond, SLASH_BPS, REPORTER_BPS);
        r.bond -= slashed.toUint128();
        r.lastSlashedAt = uint64(block.timestamp);
        claimable[s.rewardToken][reporter] += toReporter;

        uint64 forfeited;
        uint256 epoch = _epochAt(s, t, block.timestamp);
        if (block.timestamp >= s.startTime && epoch < s.numEpochs && epoch >= s.settledEpochs) {
            Epoch storage e = _epochs[id][epoch];
            e.slashBonus += toMakers.toUint128();
            forfeited = _points[id][epoch][vault];
            if (forfeited > 0) {
                _points[id][epoch][vault] = 0;
                e.totalPoints -= forfeited;
            }
        } else {
            claimable[s.rewardToken][s.creator] += toMakers;
        }
        emit Penalized(id, vault, reporter, slashed, toReporter, toMakers, forfeited);
    }

    function _referencePx(State storage s, Campaign storage t) internal view returns (uint256) {
        if (s.referencePrice == address(0)) return 0;
        try IReferencePrice(s.referencePrice).referencePrice(t.base, t.quote) returns (uint256 px, uint64 at) {
            if (at > block.timestamp || block.timestamp - at > MAX_REFERENCE_AGE) return 0;
            return px;
        } catch {
            return 0;
        }
    }

    function _validate(Campaign calldata t, uint32 numEpochs) internal view {
        if (t.base == address(0) || t.quote == address(0) || t.base == t.quote) revert BadTerms();
        if (t.epochLength < MIN_EPOCH) revert BadTerms();
        if (numEpochs == 0 || numEpochs > MAX_EPOCHS) revert BadTerms();
        if (t.rewardPerEpoch == 0 || t.makerBond == 0 || t.makerBond > type(uint128).max) revert BadTerms();
        if (t.maxSpreadBps == 0 || t.maxSpreadBps > PlumbScore.BPS) revert BadTerms();
        if (t.minProbeInterval == 0 || t.minProbeInterval >= t.epochLength) revert BadTerms();
        // Even at the fastest possible cadence, probe fees must stay within the cap.
        uint256 maxProbes = t.epochLength / t.minProbeInterval;
        if (uint256(t.probeFeeBps) * maxProbes > MAX_PROBE_SHARE_BPS) revert BadTerms();
        if (t.base.code.length == 0 || t.quote.code.length == 0) revert BadTerms();
    }

    function _termsOf(uint256 id) internal view returns (Campaign storage t) {
        t = _terms[id];
        if (t.epochLength == 0) revert UnknownCampaign();
    }

    function _epochAt(State storage s, Campaign storage t, uint256 ts) internal view returns (uint256) {
        if (ts < s.startTime) return 0;
        return (ts - s.startTime) / t.epochLength;
    }

    function _endTime(State storage s, Campaign storage t) internal view returns (uint256) {
        return uint256(s.startTime) + uint256(s.numEpochs) * t.epochLength;
    }

    function _removeVault(uint256 id, address vault) internal {
        address[] storage list = _vaults[id];
        uint256 n = list.length;
        for (uint256 i; i < n; ++i) {
            if (list[i] == vault) {
                list[i] = list[n - 1];
                list.pop();
                break;
            }
        }
        uint256[] storage ids = _vaultCampaigns[vault];
        n = ids.length;
        for (uint256 i; i < n; ++i) {
            if (ids[i] == id) {
                ids[i] = ids[n - 1];
                ids.pop();
                break;
            }
        }
    }

    function _pullExact(address token, uint256 amount) internal {
        if (token == address(0)) {
            if (msg.value != amount) revert BadFunding();
            return;
        }
        if (msg.value != 0) revert BadFunding();
        if (amount == 0) return;
        IERC20 erc = IERC20(token);
        uint256 before = erc.balanceOf(address(this));
        erc.safeTransferFrom(msg.sender, address(this), amount);
        if (erc.balanceOf(address(this)) - before != amount) revert BadFunding();
    }

    function _push(address token, address to, uint256 amount) internal {
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }
}
