import React, { useRef, useState, useEffect } from "react";
import { TextInput, View, StyleSheet } from "react-native";
import { colors, fonts } from "../lib/theme";

interface OtpInputProps {
  length?: number;
  value: string;
  onChange: (value: string) => void;
  onComplete?: (otp: string) => void;
}

export default function OtpInput({
  length = 6,
  value,
  onChange,
  onComplete,
}: OtpInputProps) {
  const [digits, setDigits] = useState<string[]>(Array(length).fill(""));
  const inputRefs = useRef<Array<TextInput | null>>([]);

  // Sync external value
  useEffect(() => {
    const newDigits = value.padEnd(length, "").slice(0, length).split("");
    setDigits(newDigits);
  }, [value, length]);

  const handleChange = (text: string, index: number) => {
    const cleaned = text.replace(/[^0-9]/g, "").slice(0, 1);
    const newDigits = [...digits];
    newDigits[index] = cleaned;
    setDigits(newDigits);

    const otpString = newDigits.join("");
    onChange(otpString);

    // Auto advance
    if (cleaned && index < length - 1) {
      setTimeout(() => {
        inputRefs.current[index + 1]?.focus();
      }, 10);
    }

    // Auto submit when complete
    if (index === length - 1 && newDigits.every((d) => d.length === 1)) {
      onComplete?.(otpString);
    }
  };

  const handleKeyPress = (e: any, index: number) => {
    if (e.nativeEvent.key === "Backspace" && !digits[index] && index > 0) {
      setTimeout(() => {
        inputRefs.current[index - 1]?.focus();
      }, 10);
    }
  };

  return (
    <View style={styles.otpContainer}>
      {digits.map((digit, index) => (
        <View
          key={index}
          style={[
            styles.otpBox,
            digit ? styles.otpBoxFilled : {},
          ]}
        >
          <TextInput
            ref={(ref) => {
                inputRefs.current[index] = ref;   // ← Fixed: explicit block
              }}
            style={styles.otpInput}
            value={digit}
            onChangeText={(text) => handleChange(text, index)}
            onKeyPress={(e) => handleKeyPress(e, index)}
            keyboardType="number-pad"
            maxLength={1}
            autoFocus={index === 0}
            selectTextOnFocus
            caretHidden
            textContentType="oneTimeCode"
          />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  otpContainer: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 18,
  },
  otpBox: {
    flex: 1,
    height: 52,
    backgroundColor: colors.background,
    borderWidth: 2,
    borderColor: colors.border,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  otpBoxFilled: {
    backgroundColor: colors.primaryLight,
    borderColor: colors.primary,
  },
  otpInput: {
    width: "100%",
    height: "100%",
    fontSize: 24,
    fontFamily: fonts.bold,
    color: colors.foreground,
    textAlign: "center",
  },
});