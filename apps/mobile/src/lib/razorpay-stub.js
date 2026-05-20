/**
 * Development stub for react-native-razorpay.
 * Used by Metro when running in Expo Go (which can't load native modules).
 * Replace with the real SDK by running: pnpm add react-native-razorpay
 * and building a custom dev client (npx expo run:android / eas build).
 */
const RazorpayCheckout = {
  open(_options) {
    return Promise.reject(
      new Error(
        "Razorpay is not available in Expo Go. Build a custom dev client to test payments."
      )
    );
  },
};

module.exports = RazorpayCheckout;
module.exports.default = RazorpayCheckout;
