import ts from "typescript";

const TIME_DOMAIN_PROPERTY = "__timelineTimeDomain";
const CHECKED_OPERATORS = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "**",
  "<",
  "<=",
  ">",
  ">=",
  "==",
  "!=",
  "===",
  "!==",
]);

function getLiteralDomain(checker, type, location) {
  if (type.isUnion()) {
    const domains = new Set(
      type.types
        .map((member) => getLiteralDomain(checker, member, location))
        .filter(Boolean),
    );
    return domains.size === 1 ? [...domains][0] : null;
  }

  const property = checker.getPropertyOfType(type, TIME_DOMAIN_PROPERTY);
  if (!property) return null;
  const declaration = property.valueDeclaration ?? property.declarations?.[0];
  const propertyType = checker.getTypeOfSymbolAtLocation(
    property,
    declaration ?? location,
  );
  return propertyType.flags & ts.TypeFlags.StringLiteral
    ? propertyType.value
    : null;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow arithmetic and comparisons between incompatible timeline time domains",
    },
    schema: [],
    messages: {
      incompatible:
        "Do not apply '{{operator}}' to {{leftDomain}} and {{rightDomain}} timeline values. Convert through TimelinePlacementMapper.",
    },
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    if (!services?.program || !services.esTreeNodeToTSNodeMap) {
      throw new Error(
        "no-incompatible-timeline-time-arithmetic requires type-aware parser services",
      );
    }
    const checker = services.program.getTypeChecker();

    return {
      BinaryExpression(node) {
        if (!CHECKED_OPERATORS.has(node.operator)) return;
        const leftNode = services.esTreeNodeToTSNodeMap.get(node.left);
        const rightNode = services.esTreeNodeToTSNodeMap.get(node.right);
        const leftDomain = getLiteralDomain(
          checker,
          checker.getTypeAtLocation(leftNode),
          leftNode,
        );
        const rightDomain = getLiteralDomain(
          checker,
          checker.getTypeAtLocation(rightNode),
          rightNode,
        );
        if (!leftDomain && !rightDomain) return;
        if (
          (node.left.type === "Literal" && node.left.value === null) ||
          (node.right.type === "Literal" && node.right.value === null)
        ) {
          return;
        }
        if (leftDomain && leftDomain === rightDomain) return;

        context.report({
          node,
          messageId: "incompatible",
          data: {
            operator: node.operator,
            leftDomain: leftDomain ?? "untyped-number",
            rightDomain: rightDomain ?? "untyped-number",
          },
        });
      },
    };
  },
};
