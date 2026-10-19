// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PlumbScore} from "./libraries/PlumbScore.sol";

/// @title PlumbQuote
/// @notice A maker's quote vault for one base/quote pair. The vault holds the maker's inventory and a
///         single two-sided quote that anyone can fill while it is fresh.
/// @dev Posting a quote is two storage slots plus a timestamp, cheap enough to repeat every block on
///      Elysium. A quote older than `maxAge` seconds is unfillable, which forces the maker to keep
///      refreshing. Withdrawals are timelocked so inventory cannot be pulled between a probe and a fill.
contract PlumbQuote is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The posted quote.
    /// @param bidPx Price the vault buys base at (PX_SCALE quote per base).
    /// @param askPx Price the vault sells base at (PX_SCALE quote per base).
    /// @param bidSize Base units the vault will buy.
    /// @param askSize Base units the vault will sell.
    /// @param updatedAt Timestamp of the last post; 0 when cancelled.
    /// @param updatedBlock Block number of the last post.
    /// @param seq Number of posts so far.
    struct Quote {
        uint128 bidPx;
        uint128 askPx;
        uint128 bidSize;
        uint128 askSize;
        uint64 updatedAt;
        uint64 updatedBlock;
        uint64 seq;
    }

    /// @notice A queued withdrawal.
    struct PendingWithdrawal {
        uint128 amount;
        uint64 readyAt;
    }

    /// @notice Result codes for `previewFill`.
    enum FillStatus {
        Ok,
        Stale,
        NoSize,
        SizeExceeded,
        InsufficientInventory,
        ZeroOut
    }

    /// @notice Factory that deployed this vault.
    address public immutable factory;
    /// @notice The maker. Holds withdrawal rights and can rotate the quoter.
    address public immutable owner;
    /// @notice Base token of the pair.
    IERC20 public immutable baseToken;
    /// @notice Quote token of the pair.
    IERC20 public immutable quoteToken;
    /// @notice 10 ** base decimals, read on-chain at deploy.
    uint256 public immutable baseUnit;
    /// @notice 10 ** quote decimals, read on-chain at deploy.
    uint256 public immutable quoteUnit;
    /// @notice Seconds after which a posted quote is stale.
    uint32 public immutable maxAge;
    /// @notice Seconds a withdrawal must wait after it is requested.
    uint32 public immutable withdrawDelay;

    /// @notice Hot key allowed to post and cancel quotes. Cannot move funds.
    address public quoter;

    Quote internal _quote;

    /// @notice Queued withdrawal per token.
    mapping(address token => PendingWithdrawal) public pendingWithdrawal;

    /// @notice Emitted on every quote post.
    event QuoteSet(uint128 bidPx, uint128 askPx, uint128 bidSize, uint128 askSize, uint64 seq);
    /// @notice Emitted when the quote is pulled.
    event QuoteCancelled(uint64 seq);
    /// @notice Emitted when the quote is filled.
    event Filled(
        address indexed taker,
        address indexed recipient,
        bool buyingBase,
        uint256 amountIn,
        uint256 amountOut,
        uint128 px
    );
    /// @notice Emitted when inventory is added.
    event Deposited(address indexed token, address indexed from, uint256 amount);
    /// @notice Emitted when a withdrawal is queued.
    event WithdrawRequested(address indexed token, uint256 amount, uint64 readyAt);
    /// @notice Emitted when a queued withdrawal is cancelled.
    event WithdrawCancelled(address indexed token);
    /// @notice Emitted when a queued withdrawal is paid out.
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    /// @notice Emitted when the quoter key changes.
    event QuoterSet(address indexed quoter);

    error NotOwner();
    error NotQuoter();
    error BadToken();
    error BadDecimals();
    error BadQuote();
    error QuoteStale();
    error SizeExceeded();
    error InsufficientInventory();
    error Slippage();
    error ZeroAmount();
    error NotReady();
    error NothingPending();
    error InputShort();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyQuoter() {
        if (msg.sender != quoter && msg.sender != owner) revert NotQuoter();
        _;
    }

    /// @param owner_ The maker.
    /// @param quoter_ Initial quoter key (may be zero; the owner can always quote).
    /// @param base_ Base token.
    /// @param quote_ Quote token.
    /// @param maxAge_ Quote freshness window in seconds.
    /// @param withdrawDelay_ Withdrawal timelock in seconds.
    constructor(
        address owner_,
        address quoter_,
        address base_,
        address quote_,
        uint32 maxAge_,
        uint32 withdrawDelay_
    ) {
        if (base_ == quote_ || base_.code.length == 0 || quote_.code.length == 0) revert BadToken();
        uint8 bd = IERC20Metadata(base_).decimals();
        uint8 qd = IERC20Metadata(quote_).decimals();
        if (bd > 18 || qd > 18) revert BadDecimals();
        factory = msg.sender;
        owner = owner_;
        quoter = quoter_;
        baseToken = IERC20(base_);
        quoteToken = IERC20(quote_);
        baseUnit = 10 ** bd;
        quoteUnit = 10 ** qd;
        maxAge = maxAge_;
        withdrawDelay = withdrawDelay_;
        emit QuoterSet(quoter_);
    }

    // ---------------------------------------------------------------------------------------------
    // Quoting
    // ---------------------------------------------------------------------------------------------

    /// @notice Post a two-sided quote. Overwrites the previous one and restarts its freshness clock.
    /// @dev Deliberately does not check balances: posting stays cheap, and the probe and the router
    ///      are where an unbacked quote gets caught and punished.
    /// @param bidPx Price to buy base at (PX_SCALE).
    /// @param askPx Price to sell base at (PX_SCALE). Must exceed `bidPx`.
    /// @param bidSize Base units to buy.
    /// @param askSize Base units to sell.
    function setQuote(uint128 bidPx, uint128 askPx, uint128 bidSize, uint128 askSize) external onlyQuoter {
        if (bidPx == 0 || askPx <= bidPx) revert BadQuote();
        Quote storage q = _quote;
        uint64 seq = q.seq + 1;
        q.bidPx = bidPx;
        q.askPx = askPx;
        q.bidSize = bidSize;
        q.askSize = askSize;
        q.updatedAt = uint64(block.timestamp);
        q.updatedBlock = uint64(block.number);
        q.seq = seq;
        emit QuoteSet(bidPx, askPx, bidSize, askSize, seq);
    }

    /// @notice Pull the quote. The vault is unfillable until the next `setQuote`.
    function cancel() external onlyQuoter {
        Quote storage q = _quote;
        q.bidSize = 0;
        q.askSize = 0;
        q.updatedAt = 0;
        emit QuoteCancelled(q.seq);
    }

    /// @notice Rotate the quoter key. Pass zero to quote from the owner key only.
    function setQuoter(address quoter_) external onlyOwner {
        quoter = quoter_;
        emit QuoterSet(quoter_);
    }

    // ---------------------------------------------------------------------------------------------
    // Inventory
    // ---------------------------------------------------------------------------------------------

    /// @notice Add inventory. Anyone may fund a vault; only the owner can withdraw.
    /// @param token Base or quote token.
    /// @param amount Raw units to pull from the caller.
    function deposit(address token, uint256 amount) external nonReentrant {
        _checkToken(token);
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(token, msg.sender, amount);
    }

    /// @notice Queue a withdrawal. The amount stops counting as quotable inventory immediately and can
    ///         be paid out after `withdrawDelay`. Replaces any withdrawal already queued for `token`.
    function requestWithdraw(address token, uint128 amount) external onlyOwner {
        _checkToken(token);
        if (amount == 0) revert ZeroAmount();
        uint64 readyAt = uint64(block.timestamp) + withdrawDelay;
        pendingWithdrawal[token] = PendingWithdrawal(amount, readyAt);
        emit WithdrawRequested(token, amount, readyAt);
    }

    /// @notice Drop a queued withdrawal; the amount counts as inventory again.
    function cancelWithdraw(address token) external onlyOwner {
        if (pendingWithdrawal[token].amount == 0) revert NothingPending();
        delete pendingWithdrawal[token];
        emit WithdrawCancelled(token);
    }

    /// @notice Pay out a queued withdrawal once its timelock has passed.
    /// @param token Base or quote token.
    /// @param to Recipient.
    function executeWithdraw(address token, address to) external onlyOwner nonReentrant {
        PendingWithdrawal memory w = pendingWithdrawal[token];
        if (w.amount == 0) revert NothingPending();
        if (block.timestamp < w.readyAt) revert NotReady();
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 amount = w.amount < bal ? w.amount : bal;
        delete pendingWithdrawal[token];
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, to, amount);
    }

    /// @notice Balance of `token` the vault can quote against: holdings minus any queued withdrawal.
    function freeBalance(address token) public view returns (uint256) {
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 pending = pendingWithdrawal[token].amount;
        return pending >= bal ? 0 : bal - pending;
    }

    // ---------------------------------------------------------------------------------------------
    // Filling
    // ---------------------------------------------------------------------------------------------

    /// @notice Fill against the live quote. The caller pays `amountIn` and `recipient` receives the output.
    /// @dev Buying base pays quote at `askPx` and consumes `askSize`. Selling base receives quote at
    ///      `bidPx` and consumes `bidSize`. The vault pulls `amountIn` from the caller, so a router must
    ///      approve the vault first. Output is rounded down in the vault's favour.
    /// @param buyingBase True to buy base with quote; false to sell base for quote.
    /// @param amountIn Raw input units.
    /// @param minOut Minimum raw output units.
    /// @param recipient Receiver of the output.
    /// @return amountOut Raw output units sent to `recipient`.
    function fill(bool buyingBase, uint256 amountIn, uint256 minOut, address recipient)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        Quote storage q = _quote;
        if (!PlumbScore.isFresh(q.updatedAt, maxAge, block.timestamp)) revert QuoteStale();
        if (amountIn == 0) revert ZeroAmount();

        IERC20 tokenIn;
        IERC20 tokenOut;
        uint128 px;
        if (buyingBase) {
            px = q.askPx;
            amountOut = PlumbScore.baseForQuote(amountIn, px, baseUnit, quoteUnit);
            if (amountOut > q.askSize) revert SizeExceeded();
            if (freeBalance(address(baseToken)) < amountOut) revert InsufficientInventory();
            // forge-lint: disable-next-line(unsafe-typecast) amountOut <= askSize, checked above
            q.askSize -= uint128(amountOut);
            tokenIn = quoteToken;
            tokenOut = baseToken;
        } else {
            px = q.bidPx;
            if (amountIn > q.bidSize) revert SizeExceeded();
            amountOut = PlumbScore.quoteNotional(amountIn, px, baseUnit, quoteUnit);
            if (freeBalance(address(quoteToken)) < amountOut) revert InsufficientInventory();
            // forge-lint: disable-next-line(unsafe-typecast) amountIn <= bidSize, checked above
            q.bidSize -= uint128(amountIn);
            tokenIn = baseToken;
            tokenOut = quoteToken;
        }
        if (amountOut == 0 || amountOut < minOut) revert Slippage();

        uint256 before = tokenIn.balanceOf(address(this));
        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);
        if (tokenIn.balanceOf(address(this)) - before < amountIn) revert InputShort();
        tokenOut.safeTransfer(recipient, amountOut);

        emit Filled(msg.sender, recipient, buyingBase, amountIn, amountOut, px);
    }

    /// @notice What `fill` would do right now, without reverting.
    /// @return amountOut Output the fill would pay.
    /// @return status `Ok` if the fill would succeed, otherwise the first reason it would not.
    function previewFill(bool buyingBase, uint256 amountIn)
        external
        view
        returns (uint256 amountOut, FillStatus status)
    {
        Quote memory q = _quote;
        if (!PlumbScore.isFresh(q.updatedAt, maxAge, block.timestamp)) return (0, FillStatus.Stale);
        if (buyingBase) {
            if (q.askSize == 0) return (0, FillStatus.NoSize);
            amountOut = PlumbScore.baseForQuote(amountIn, q.askPx, baseUnit, quoteUnit);
            if (amountOut > q.askSize) return (amountOut, FillStatus.SizeExceeded);
            if (freeBalance(address(baseToken)) < amountOut) return (amountOut, FillStatus.InsufficientInventory);
        } else {
            if (q.bidSize == 0) return (0, FillStatus.NoSize);
            if (amountIn > q.bidSize) return (0, FillStatus.SizeExceeded);
            amountOut = PlumbScore.quoteNotional(amountIn, q.bidPx, baseUnit, quoteUnit);
            if (freeBalance(address(quoteToken)) < amountOut) {
                return (amountOut, FillStatus.InsufficientInventory);
            }
        }
        if (amountOut == 0) return (0, FillStatus.ZeroOut);
        return (amountOut, FillStatus.Ok);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice The current quote.
    function quote() external view returns (Quote memory) {
        return _quote;
    }

    /// @notice True while the quote is fresh.
    function isLive() public view returns (bool) {
        return PlumbScore.isFresh(_quote.updatedAt, maxAge, block.timestamp);
    }

    /// @notice One-call read used by probes: the quote, its freshness window, and the inventory
    ///         actually held right now, net of queued withdrawals.
    function probeSnapshot()
        external
        view
        returns (Quote memory q, uint32 maxAge_, uint256 freeBase, uint256 freeQuote)
    {
        q = _quote;
        maxAge_ = maxAge;
        freeBase = freeBalance(address(baseToken));
        freeQuote = freeBalance(address(quoteToken));
    }

    function _checkToken(address token) internal view {
        if (token != address(baseToken) && token != address(quoteToken)) revert BadToken();
    }
}
