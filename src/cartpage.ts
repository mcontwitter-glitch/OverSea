// /cart: multi-collection, cross-chain cart.
import { checkApi, onWallet } from './wallet';
import { frame, onCart } from './gx';
import { cartPage } from './cart';
const el = frame('cart', 'Cart');
const redraw = cartPage(el); onCart(redraw); onWallet(redraw); checkApi();
