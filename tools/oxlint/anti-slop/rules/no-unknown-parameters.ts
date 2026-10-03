import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

type Parameter = ESTree.ParamPattern;
type ParameterOwner =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

function parameterAnnotation(parameter: Parameter): ESTree.TSTypeAnnotation | null | undefined {
  if (parameter.type === "TSParameterProperty") {
    return parameterAnnotation(parameter.parameter);
  }
  if (parameter.type === "RestElement") {
    return parameter.typeAnnotation ?? parameterAnnotation(parameter.argument);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameter.typeAnnotation ?? parameter.left.typeAnnotation;
  }
  return parameter.typeAnnotation;
}

function parameterName(parameter: Parameter, sourceText: string): string {
  if (parameter.type === "TSParameterProperty") {
    return parameterName(parameter.parameter, sourceText);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameterName(parameter.left, sourceText);
  }
  if (parameter.type === "RestElement") {
    return parameterName(parameter.argument, sourceText);
  }
  return parameter.type === "Identifier"
    ? parameter.name
    : sourceText.replace(/\s*:\s*unknown\s*$/u, "");
}

function isUnconstrainedParserInput(node: ParameterOwner, type: ESTree.TSType, sourceCode: SourceCode): boolean {
  if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier" || !node.returnType) return false;
  const name = type.typeName.name;
  const parameter = node.typeParameters?.params.find((candidate) => candidate.name.name === name);
  if (!parameter || parameter.constraint) return false;
  const referencesParameter = (annotation: ESTree.Node) =>
    sourceCode.getTokens(annotation).some((token) => token.type === "Identifier" && token.value === name);
  if (referencesParameter(node.returnType)) return false;
  if (node.typeParameters?.params.some((other) =>
    other.constraint && referencesParameter(other.constraint))) return false;
  return !node.params.some((other) => {
    const annotation = parameterAnnotation(other)?.typeAnnotation;
    return annotation && annotation !== type && referencesParameter(annotation);
  });
}

/** Disallow unknown inputs and unconstrained parser-only generics except named error causes. */
export const noUnknownParametersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow unknown parameters and parser-only unconstrained generics except `cause`; validate external inputs at their boundary.",
    },
    messages: {
      unknownParameter:
        "Parameter `{{parameter}}` leaves input unparsed. Accept a named domain type; run the expected schema or parser at the I/O boundary before calling this function.",
    },
  },
  createOnce(context) {
    const checkParameters = (node: ParameterOwner) => {
      for (const parameter of node.params) {
        const annotation = parameterAnnotation(parameter);
        if (!annotation) continue;
        if (annotation.typeAnnotation.type !== "TSUnknownKeyword" &&
          !isUnconstrainedParserInput(node, annotation.typeAnnotation, context.sourceCode)) continue;
        const name = parameterName(parameter, context.sourceCode.getText(parameter));
        if (name === "cause") continue;
        context.report({
          node: annotation.typeAnnotation,
          messageId: "unknownParameter",
          data: { parameter: name },
        });
      }
    };

    return {
      ArrowFunctionExpression: checkParameters,
      FunctionDeclaration: checkParameters,
      FunctionExpression: checkParameters,
      TSCallSignatureDeclaration: checkParameters,
      TSConstructSignatureDeclaration: checkParameters,
      TSConstructorType: checkParameters,
      TSDeclareFunction: checkParameters,
      TSEmptyBodyFunctionExpression: checkParameters,
      TSFunctionType: checkParameters,
      TSMethodSignature: checkParameters,
    };
  },
});
